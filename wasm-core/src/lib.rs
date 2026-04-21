use wasm_bindgen::prelude::*;
use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::{Serialize, Deserialize};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};
use aho_corasick::AhoCorasick;
use rand::prelude::*;
use rand::rngs::SmallRng;
use rand_distr::{Distribution, Normal};

// Install a panic hook so Rust panics surface as readable JS errors instead
// of opaque `RuntimeError: unreachable`, which poisons the whole module and
// leaves no diagnostic trail. Runs automatically on module instantiation.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

// ---------------------------------------------------------------------------
// Public Suffix guard — mirrors `src/shared/psl.js`. We stop ascending
// hostname ancestor chains at any suffix in this set to prevent `co.uk`
// (etc.) from matching entire TLDs in allowlist / bloom lookups.
// ---------------------------------------------------------------------------
fn public_suffixes() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "com", "org", "net", "edu", "gov", "mil", "int", "io", "co", "ai",
            "app", "dev", "info", "biz", "me", "tv", "xyz", "online", "site",
            "store", "shop", "tech", "cloud", "blog", "news", "art",
            "uk", "us", "de", "fr", "it", "es", "nl", "be", "ch", "at", "se",
            "no", "dk", "fi", "pl", "cz", "pt", "gr", "ie", "au", "nz", "ca",
            "mx", "br", "ar", "cl", "pe", "ru", "ua", "by", "tr", "il", "sa",
            "ae", "eg", "za", "ng", "ke", "ma", "jp", "kr", "cn", "hk", "tw",
            "sg", "my", "id", "th", "vn", "ph", "in", "pk", "bd", "lk",
            "co.uk", "org.uk", "gov.uk", "ac.uk", "net.uk", "sch.uk", "nhs.uk",
            "com.au", "net.au", "org.au", "edu.au", "gov.au",
            "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
            "co.kr", "or.kr", "ne.kr", "go.kr", "ac.kr",
            "com.br", "net.br", "org.br", "gov.br", "edu.br",
            "com.mx", "org.mx", "gob.mx",
            "com.ar", "org.ar", "gob.ar", "gov.ar",
            "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
            "com.sg", "edu.sg", "gov.sg",
            "com.hk", "org.hk", "gov.hk",
            "com.tw", "org.tw", "gov.tw", "edu.tw",
            "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
            "co.in", "net.in", "org.in", "gov.in", "ac.in",
            "co.il", "org.il", "gov.il", "ac.il",
            "co.za", "org.za", "gov.za", "ac.za",
            "com.tr", "org.tr", "gov.tr", "edu.tr",
            "com.ua", "org.ua", "gov.ua", "edu.ua",
            "com.ru", "org.ru", "gov.ru",
            "github.io", "gitlab.io", "netlify.app", "vercel.app", "herokuapp.com",
            "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
            "s3.amazonaws.com", "cloudfront.net",
        ].into_iter().collect()
    })
}

fn is_public_suffix(host: &str) -> bool {
    host.is_empty() || public_suffixes().contains(host)
}

// ---------------------------------------------------------------------------
// Bloom Filter
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct BloomFilter {
    size: usize,
    hashes: u8,
    bitset: Vec<u32>,
}

#[wasm_bindgen]
impl BloomFilter {
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize, hashes: u8) -> Self {
        let bitset_size = (size + 31) / 32;
        Self {
            size,
            hashes,
            bitset: vec![0; bitset_size],
        }
    }

    pub fn add(&mut self, key: &str) {
        for i in 0..self.hashes {
            let hash = self.calculate_hash(key, i);
            let index = (hash as usize) % self.size;
            self.bitset[index >> 5] |= 1 << (index & 31);
        }
    }

    pub fn has(&self, key: &str) -> bool {
        for i in 0..self.hashes {
            let hash = self.calculate_hash(key, i);
            let index = (hash as usize) % self.size;
            if (self.bitset[index >> 5] & (1 << (index & 31))) == 0 {
                return false;
            }
        }
        true
    }

    fn calculate_hash(&self, key: &str, seed: u8) -> u64 {
        let mut h = 0x811c9dc5u64 ^ (seed as u64);
        for b in key.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }

    pub fn serialize_to_json(&self) -> String {
        let s = SerializedBloom {
            size: self.size,
            hashes: self.hashes,
            data: self.bitset.clone(),
        };
        serde_json::to_string(&s).unwrap_or_default()
    }

    pub fn deserialize_from_json(json: &str) -> Self {
        // Fall back to an empty filter on malformed input rather than
        // panicking through WASM — a corrupt stored bloom filter should
        // degrade gracefully, not crash the whole rule pipeline.
        match serde_json::from_str::<SerializedBloom>(json) {
            Ok(s) => Self { size: s.size, hashes: s.hashes, bitset: s.data },
            Err(_) => Self::new(1, 1),
        }
    }

    pub fn check_hostname(&self, hostname: &str) -> bool {
        if self.has("") { return true; }
        let mut d = hostname;
        loop {
            if is_public_suffix(d) { break; }
            if self.has(d) { return true; }
            match d.find('.') {
                Some(idx) => d = &d[idx + 1..],
                None => break,
            }
        }
        false
    }
}

#[derive(Serialize, Deserialize)]
struct SerializedBloom {
    size: usize,
    hashes: u8,
    data: Vec<u32>,
}

// ---------------------------------------------------------------------------
// Filter Parser & DNR Compiler
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct BucketedCosmeticRules {
    generic: Vec<String>,
    #[serde(rename = "domainSpecific")]
    domain_specific: HashMap<String, Vec<String>>,
    #[serde(rename = "genericExceptions")]
    generic_exceptions: Vec<String>,
    #[serde(rename = "domainExceptions")]
    domain_exceptions: HashMap<String, Vec<String>>,
}

#[derive(Serialize, Deserialize, Default)]
struct CompiledUserFilters {
    #[serde(rename = "dnrRules")]
    dnr_rules: Vec<DnrRule>,
    #[serde(rename = "cosmeticRules")]
    cosmetic_rules: BucketedCosmeticRules,
    #[serde(rename = "scriptletRules")]
    scriptlet_rules: Vec<ParsedRule>,
}

#[cfg(test)]
#[derive(Serialize, Deserialize, Default)]
struct MergedFilterData {
    generic: Vec<String>,
    #[serde(rename = "domainSpecific")]
    domain_specific: HashMap<String, Vec<String>>,
    #[serde(rename = "scriptletRules")]
    scriptlet_rules: Vec<ParsedRule>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct FilterSourceCosmetic {
    generic: Vec<String>,
    #[serde(rename = "domainSpecific")]
    domain_specific: HashMap<String, Vec<String>>,
    exceptions: HashMap<String, Vec<String>>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct FilterSourceBundle {
    cosmetic: FilterSourceCosmetic,
    scriptlets: Vec<ParsedRule>,
}

fn from_js_value<T>(value: JsValue) -> T
where
    T: for<'de> Deserialize<'de> + Default,
{
    serde_wasm_bindgen::from_value(value).unwrap_or_default()
}

fn to_js_value<T>(value: &T) -> JsValue
where
    T: Serialize,
{
    value.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .unwrap_or(JsValue::NULL)
}

fn should_skip_filter_line(line: &str) -> bool {
    line.is_empty()
        || line.starts_with('!')
        || line.starts_with('[')
        || line.starts_with('%')
        || line.starts_with("@@#")
}

fn push_unique(list: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
    let trimmed = value.trim();
    if !is_valid_selector(trimmed) {
        return;
    }
    let owned = trimmed.to_string();
    if seen.insert(owned.clone()) {
        list.push(owned);
    }
}

fn push_unique_domain_selector(
    map: &mut HashMap<String, Vec<String>>,
    seen_map: &mut HashMap<String, HashSet<String>>,
    domain: &str,
    selector: &str,
) {
    let domain = domain.trim().to_lowercase();
    let selector = selector.trim();
    if domain.is_empty() || !is_valid_selector(selector) {
        return;
    }

    let selector_owned = selector.to_string();
    let domain_seen = seen_map.entry(domain.clone()).or_default();
    if !domain_seen.insert(selector_owned.clone()) {
        return;
    }

    map.entry(domain).or_default().push(selector_owned);
}

fn scriptlet_fingerprint(rule: &ParsedRule) -> String {
    let mut domains = rule.domains.clone();
    domains.sort();
    format!(
        "{}|{}|{}",
        rule.name.as_deref().unwrap_or_default(),
        domains.join(","),
        rule.args.as_deref().unwrap_or(&[]).join(","),
    )
}

fn compile_user_filters_internal(text: &str, start_id: u32) -> CompiledUserFilters {
    let mut compiled = CompiledUserFilters::default();
    let mut next_id = start_id;
    let mut network_seen = HashSet::new();
    let mut generic_seen = HashSet::new();
    let mut generic_exception_seen = HashSet::new();
    let mut domain_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut domain_exception_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut scriptlet_seen = HashSet::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if should_skip_filter_line(line) {
            continue;
        }

        if let Some(rule) = parse_line(line) {
            if rule.rule_type == "scriptlet" {
                let fingerprint = scriptlet_fingerprint(&rule);
                if scriptlet_seen.insert(fingerprint) {
                    compiled.scriptlet_rules.push(rule);
                }
                continue;
            }

            let Some(selector) = rule.selector.as_deref() else {
                continue;
            };
            if rule.domains.is_empty() {
                if rule.exception.unwrap_or(false) {
                    push_unique(
                        &mut compiled.cosmetic_rules.generic_exceptions,
                        &mut generic_exception_seen,
                        selector,
                    );
                } else {
                    push_unique(
                        &mut compiled.cosmetic_rules.generic,
                        &mut generic_seen,
                        selector,
                    );
                }
            } else {
                for domain in &rule.domains {
                    if rule.exception.unwrap_or(false) {
                        push_unique_domain_selector(
                            &mut compiled.cosmetic_rules.domain_exceptions,
                            &mut domain_exception_seen,
                            domain,
                            selector,
                        );
                    } else {
                        push_unique_domain_selector(
                            &mut compiled.cosmetic_rules.domain_specific,
                            &mut domain_seen,
                            domain,
                            selector,
                        );
                    }
                }
            }
            continue;
        }

        if line.contains("##") || line.contains("#@#") || line.contains("#?#") {
            continue;
        }

        if let Some(rule) = parse_network_rule_to_dnr(line, next_id) {
            if network_seen.insert(line.to_string()) {
                compiled.dnr_rules.push(rule);
                next_id += 1;
            }
        }
    }

    compiled
}

#[wasm_bindgen]
pub fn compile_user_filters(text: &str, start_id: u32) -> JsValue {
    to_js_value(&compile_user_filters_internal(text, start_id))
}

#[cfg(test)]
fn merge_filter_sources_internal(
    bundled_generic_in: Vec<String>,
    bundled_domain_specific_in: HashMap<String, Vec<String>>,
    bundled_scriptlets_in: Vec<ParsedRule>,
    remote_texts_in: Vec<String>,
) -> MergedFilterData {
    let mut merged = MergedFilterData::default();
    let mut generic_seen = HashSet::new();
    let mut domain_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut scriptlet_seen = HashSet::new();

    for selector in bundled_generic_in {
        push_unique(&mut merged.generic, &mut generic_seen, &selector);
    }

    for (domain, selectors) in bundled_domain_specific_in {
        for selector in selectors {
            push_unique_domain_selector(
                &mut merged.domain_specific,
                &mut domain_seen,
                &domain,
                &selector,
            );
        }
    }

    for rule in bundled_scriptlets_in {
        let fingerprint = scriptlet_fingerprint(&rule);
        if scriptlet_seen.insert(fingerprint) {
            merged.scriptlet_rules.push(rule);
        }
    }

    let mut exceptions: HashMap<String, Vec<String>> = HashMap::new();
    let mut exception_seen: HashMap<String, HashSet<String>> = HashMap::new();

    for text in remote_texts_in {
        for raw_line in text.lines() {
            let line = raw_line.trim();
            if should_skip_filter_line(line) {
                continue;
            }

            let Some(rule) = parse_line(line) else {
                continue;
            };

            match rule.rule_type.as_str() {
                "scriptlet" => {
                    let fingerprint = scriptlet_fingerprint(&rule);
                    if scriptlet_seen.insert(fingerprint) {
                        merged.scriptlet_rules.push(rule);
                    }
                }
                "cosmetic" => {
                    let Some(selector) = rule.selector.as_deref() else {
                        continue;
                    };
                    if rule.domains.is_empty() {
                        if !rule.exception.unwrap_or(false) {
                            push_unique(&mut merged.generic, &mut generic_seen, selector);
                        }
                        continue;
                    }

                    for domain in &rule.domains {
                        if rule.exception.unwrap_or(false) {
                            push_unique_domain_selector(
                                &mut exceptions,
                                &mut exception_seen,
                                domain,
                                selector,
                            );
                        } else {
                            push_unique_domain_selector(
                                &mut merged.domain_specific,
                                &mut domain_seen,
                                domain,
                                selector,
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    }

    let generic_set: HashSet<&str> = merged.generic.iter().map(String::as_str).collect();
    for selectors in merged.domain_specific.values_mut() {
        selectors.retain(|selector| !generic_set.contains(selector.as_str()));
    }

    for (domain, selectors) in exceptions {
        let entry = merged.domain_specific.entry(domain).or_default();
        let mut local_seen: HashSet<String> = entry.iter().cloned().collect();
        for selector in selectors {
            let prefixed = format!("__exception__{selector}");
            if local_seen.insert(prefixed.clone()) {
                entry.push(prefixed);
            }
        }
    }

    merged.domain_specific.retain(|_, selectors| !selectors.is_empty());
    merged
}

#[wasm_bindgen]
pub fn parse_filter_source(text: &str) -> JsValue {
    let mut bundle = FilterSourceBundle::default();
    let mut generic_seen = HashSet::new();
    let mut domain_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut exception_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut scriptlet_seen = HashSet::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if should_skip_filter_line(line) {
            continue;
        }

        let Some(rule) = parse_line(line) else {
            continue;
        };

        match rule.rule_type.as_str() {
            "scriptlet" => {
                let fingerprint = scriptlet_fingerprint(&rule);
                if scriptlet_seen.insert(fingerprint) {
                    bundle.scriptlets.push(rule);
                }
            }
            "cosmetic" => {
                let Some(selector) = rule.selector.as_deref() else {
                    continue;
                };

                if rule.domains.is_empty() {
                    if !rule.exception.unwrap_or(false) {
                        push_unique(
                            &mut bundle.cosmetic.generic,
                            &mut generic_seen,
                            selector,
                        );
                    }
                    continue;
                }

                for domain in &rule.domains {
                    if rule.exception.unwrap_or(false) {
                        push_unique_domain_selector(
                            &mut bundle.cosmetic.exceptions,
                            &mut exception_seen,
                            domain,
                            selector,
                        );
                    } else {
                        push_unique_domain_selector(
                            &mut bundle.cosmetic.domain_specific,
                            &mut domain_seen,
                            domain,
                            selector,
                        );
                    }
                }
            }
            _ => {}
        }
    }

    to_js_value(&bundle)
}

fn build_allowlist_rules_internal(allowlist: Vec<String>, start_id: u32) -> Vec<DnrRule> {
    let mut seen = HashSet::new();
    let mut rules = Vec::new();

    for (index, domain) in allowlist
        .into_iter()
        .map(|domain| domain.trim().to_lowercase())
        .filter(|domain| !domain.is_empty())
        .filter(|domain| seen.insert(domain.clone()))
        .enumerate()
    {
        rules.push(DnrRule {
            id: start_id + index as u32,
            priority: 500,
            action: DnrAction {
                action_type: "allowAllRequests".to_string(),
                redirect: None,
            },
            condition: DnrCondition {
                url_filter: Some(format!("||{domain}^")),
                resource_types: Some(vec!["main_frame".to_string(), "sub_frame".to_string()]),
                ..Default::default()
            },
        });
    }

    rules
}

#[wasm_bindgen]
pub fn build_allowlist_rules(allowlist: JsValue, start_id: u32) -> JsValue {
    let allowlist: Vec<String> = from_js_value(allowlist);
    to_js_value(&build_allowlist_rules_internal(allowlist, start_id))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ParsedRule {
    #[serde(rename = "type")]
    rule_type: String,
    domains: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exception: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<Vec<String>>,
}

fn parse_line(line: &str) -> Option<ParsedRule> {
    if line.contains("##+js(") || line.contains("#+js(") { return parse_scriptlet(line); }
    if let Some(idx) = line.find("#@#") {
        return Some(ParsedRule { rule_type: "cosmetic".into(), domains: parse_domains(&line[..idx]), selector: Some(line[idx+3..].into()), exception: Some(true), name: None, args: None });
    }
    if let Some(idx) = line.find("#?#") {
        return Some(ParsedRule { rule_type: "cosmetic".into(), domains: parse_domains(&line[..idx]), selector: Some(line[idx+3..].into()), exception: Some(false), name: None, args: None });
    }
    if let Some(idx) = line.find("##") {
        return Some(ParsedRule { rule_type: "cosmetic".into(), domains: parse_domains(&line[..idx]), selector: Some(line[idx+2..].into()), exception: Some(false), name: None, args: None });
    }
    None
}

fn parse_domains(domains: &str) -> Vec<String> {
    domains.split(',').map(|d| d.trim().into()).filter(|d: &String| !d.is_empty()).collect()
}

fn parse_scriptlet(line: &str) -> Option<ParsedRule> {
    let (domains, rest) = if let Some(idx) = line.find("##+js(") {
        (&line[..idx], &line[idx + 6..line.len() - 1])
    } else if let Some(idx) = line.find("#+js(") {
        (&line[..idx], &line[idx + 5..line.len() - 1])
    } else { return None; };
    let args = parse_scriptlet_args(rest);
    let mut args_iter = args.into_iter();
    let name = args_iter.next()?;
    Some(ParsedRule { rule_type: "scriptlet".into(), domains: parse_domains(domains), selector: None, exception: None, name: Some(name), args: Some(args_iter.collect()) })
}

fn parse_scriptlet_args(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false; let mut in_double = false;
    for ch in s.chars() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            ',' if !in_single && !in_double => {
                args.push(current.trim().trim_matches(|c| c == '\'' || c == '"').to_string());
                current = String::new();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() { args.push(current.trim().trim_matches(|c| c == '\'' || c == '"').to_string()); }
    args
}

#[derive(Serialize, Deserialize)]
pub struct DnrRule { id: u32, priority: u16, action: DnrAction, condition: DnrCondition }
#[derive(Serialize, Deserialize)]
pub struct DnrAction { #[serde(rename = "type")] action_type: String, #[serde(skip_serializing_if = "Option::is_none")] redirect: Option<DnrRedirect> }
#[derive(Serialize, Deserialize)]
pub struct DnrRedirect { #[serde(skip_serializing_if = "Option::is_none")] url: Option<String> }

#[derive(Serialize, Deserialize, Default)]
pub struct DnrCondition { 
    #[serde(rename = "urlFilter", skip_serializing_if = "Option::is_none")] 
    pub url_filter: Option<String>,
    #[serde(rename = "regexFilter", skip_serializing_if = "Option::is_none")] 
    pub regex_filter: Option<String>,
    #[serde(rename = "resourceTypes", skip_serializing_if = "Option::is_none")] 
    pub resource_types: Option<Vec<String>>,
    #[serde(rename = "excludedResourceTypes", skip_serializing_if = "Option::is_none")] 
    pub excluded_resource_types: Option<Vec<String>>,
    #[serde(rename = "domainType", skip_serializing_if = "Option::is_none")] 
    pub domain_type: Option<String>
}

// Counts filter rules dropped by the critical-path guard in
// `parse_network_rule_to_dnr`. Previously these were discarded silently,
// which made filter-list breakage untraceable. JS reads this via
// `critical_path_drop_count()` so the diagnostic surfaces in the UI.
static CRITICAL_PATH_DROPS: AtomicU32 = AtomicU32::new(0);

#[wasm_bindgen]
pub fn critical_path_drop_count() -> u32 {
    CRITICAL_PATH_DROPS.load(Ordering::Relaxed)
}

#[wasm_bindgen]
pub fn reset_critical_path_drop_count() {
    CRITICAL_PATH_DROPS.store(0, Ordering::Relaxed);
}

fn parse_network_rule_to_dnr(line: &str, id: u32) -> Option<DnrRule> {
    let is_exception = line.starts_with("@@");
    let pattern_part = if is_exception { &line[2..] } else { line };

    let (pattern, options_str) = match pattern_part.find('$') {
        Some(idx) => (&pattern_part[..idx], Some(&pattern_part[idx + 1..])),
        None => (pattern_part, None),
    };

    if pattern.is_empty() || pattern == "*" || pattern == "||" { return None; }

    // Safe Path Guard (Rust edition)
    let critical_paths = [
        "youtube.com/youtubei/v1/player",
        "youtube.com/youtubei/v1/next",
        "youtube.com/youtubei/v1/browse",
        "youtube.com/youtubei/v1/log_event",
        "youtube.com/api/stats/",
        "googlevideo.com/videoplayback",
        "accounts.google.com/",
        "login.microsoftonline.com",
        "aexp-static.com",
    ];
    let lower_pattern = pattern.to_lowercase();
    for path in critical_paths.iter() {
        if lower_pattern.contains(path) && !is_exception {
            // Check if it's marked as important
            let mut is_important = false;
            if let Some(opts) = options_str {
                if opts.contains("important") { is_important = true; }
            }
            if !is_important {
                // Tick diagnostic counter so silent drops are auditable.
                CRITICAL_PATH_DROPS.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        }
    }

    let mut condition = DnrCondition::default();
    let mut is_important = false;

    if pattern.starts_with('/') && pattern.ends_with('/') && pattern.len() > 2 {
        condition.regex_filter = Some(pattern[1..pattern.len()-1].to_string());
    } else {
        condition.url_filter = Some(pattern.to_string());
    }

    if let Some(opts) = options_str {
        for opt in opts.split(',') {
            let opt_trimmed = opt.trim();
            let negated = opt_trimmed.starts_with('~');
            let opt_name = if negated { &opt_trimmed[1..] } else { opt_trimmed };

            match opt_name {
                "important" => is_important = true,
                "script" | "image" | "stylesheet" | "xmlhttprequest" | "subdocument" | "document" | "media" | "font" | "websocket" | "ping" | "other" => {
                    let dnr_type = match opt_name {
                        "subdocument" => "sub_frame",
                        "document" => "main_frame",
                        _ => opt_name,
                    }.to_string();

                    if negated {
                        let mut types = condition.excluded_resource_types.unwrap_or_default();
                        types.push(dnr_type);
                        condition.excluded_resource_types = Some(types);
                    } else {
                        let mut types = condition.resource_types.unwrap_or_default();
                        types.push(dnr_type);
                        condition.resource_types = Some(types);
                    }
                },
                "third-party" | "3p" => {
                    condition.domain_type = Some(if negated { "firstParty" } else { "thirdParty" }.to_string());
                },
                "first-party" | "1p" => {
                    condition.domain_type = Some(if negated { "thirdParty" } else { "firstParty" }.to_string());
                },
                _ => {} 
            }
        }
    }

    let priority = if is_exception { 10u16 } else if is_important { 5u16 } else { 1u16 };

    Some(DnrRule {
        id,
        priority,
        action: DnrAction {
            action_type: if is_exception { "allow" } else { "block" }.to_string(),
            redirect: None,
        },
        condition,
    })
}

// ---------------------------------------------------------------------------
// Aho-Corasick Matcher
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct KeywordMatcher { ac: AhoCorasick }

#[wasm_bindgen]
impl KeywordMatcher {
    #[wasm_bindgen(constructor)]
    pub fn new(patterns_csv: &str) -> Self {
        let patterns: Vec<&str> = patterns_csv.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        // Matches `UrlSanitizer::new` — fall back to an empty automaton on
        // AhoCorasick construction failure rather than panicking across the
        // JS boundary.
        let ac = AhoCorasick::new(&patterns)
            .unwrap_or_else(|_| AhoCorasick::new::<[&str; 0], &str>([]).unwrap());
        Self { ac }
    }
    pub fn matches(&self, text: &str) -> bool { self.ac.is_match(text) }
}

// ---------------------------------------------------------------------------
// AllowlistMatcher — stateful, built once, O(1) per check
// ---------------------------------------------------------------------------

/// Stateful allowlist checker. Build once after loading the allowlist from
/// storage; call `.check(hostname)` on every request instead of converting
/// the allowlist Set→Array→CSV and rescanning it each time.
#[wasm_bindgen]
pub struct AllowlistMatcher {
    domains: HashSet<String>,
}

#[wasm_bindgen]
impl AllowlistMatcher {
    #[wasm_bindgen(constructor)]
    pub fn new(csv: &str) -> Self {
        let domains = csv.split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        Self { domains }
    }

    /// Returns true if `hostname` or any of its parent domains (up to but
    /// excluding the first public suffix) is in the allowlist. Without the
    /// public-suffix guard a rule at e.g. `co.uk` would match every site on
    /// that TLD.
    pub fn check(&self, hostname: &str) -> bool {
        let lower = hostname.to_lowercase();
        let mut h: &str = &lower;
        loop {
            if is_public_suffix(h) { return false; }
            if self.domains.contains(h) { return true; }
            match h.find('.') {
                Some(idx) => h = &h[idx + 1..],
                None => return false,
            }
        }
    }

    pub fn add(&mut self, domain: &str) {
        self.domains.insert(domain.trim().to_lowercase());
    }

    /// `remove` is a reserved keyword in wasm-bindgen; use remove_domain.
    pub fn remove_domain(&mut self, domain: &str) {
        self.domains.remove(domain.trim().to_lowercase().as_str());
    }

    pub fn size(&self) -> usize { self.domains.len() }
}

// ---------------------------------------------------------------------------
// UrlSanitizer — stateful, AhoCorasick built once for tracking-param stripping
// ---------------------------------------------------------------------------

/// Pre-compiles tracking parameter keywords into an AhoCorasick automaton once.
/// Call `.sanitize(url)` on every request instead of rebuilding the automaton.
#[wasm_bindgen]
pub struct UrlSanitizer {
    ac: AhoCorasick,
}

#[wasm_bindgen]
impl UrlSanitizer {
    #[wasm_bindgen(constructor)]
    pub fn new(patterns_csv: &str) -> Self {
        let patterns: Vec<&str> = patterns_csv.split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        let ac = AhoCorasick::new(&patterns)
            .unwrap_or_else(|_| AhoCorasick::new::<[&str; 0], &str>([]).unwrap());
        Self { ac }
    }

    pub fn sanitize(&self, url: &str) -> String {
        let Some((base, query)) = url.split_once('?') else {
            return url.to_string();
        };
        let clean: Vec<&str> = query.split('&')
            .filter(|pair| {
                let key = pair.split('=').next().unwrap_or("");
                !self.ac.is_match(key)
            })
            .collect();
        if clean.is_empty() { base.to_string() }
        else { format!("{}?{}", base, clean.join("&")) }
    }
}

// ---------------------------------------------------------------------------
// Procedural Selector Planning
// ---------------------------------------------------------------------------

/// All uBO/ABP procedural operators, longest-first to prevent partial prefix matches.
fn proc_op_ac() -> &'static AhoCorasick {
    static AC: OnceLock<AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| AhoCorasick::new([
        ":matches-css-before(",
        ":matches-css-after(",
        ":matches-css(",
        ":has-text(",
        ":nth-ancestor(",
        ":min-text-length(",
        ":matches-path(",
        ":matches-attr(",
        ":watch-attr(",
        ":upward(",
        ":remove(",
        ":style(",
        ":xpath(",
        ":if-not(",
        ":semantic(",
        ":if(",
    ]).unwrap())
}

#[derive(Serialize, Deserialize, Clone)]
struct ProceduralPlanStep {
    #[serde(rename = "type")]
    step_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    op: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    arg: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct PlannedSelectorRule {
    selector: String,
    plan: Vec<ProceduralPlanStep>,
}

#[derive(Serialize, Deserialize, Default)]
struct PlannedSelectorBundle {
    #[serde(rename = "cssSelectors")]
    css_selectors: Vec<String>,
    #[serde(rename = "proceduralRules")]
    procedural_rules: Vec<PlannedSelectorRule>,
}

#[derive(Serialize, Deserialize, Default)]
struct ReducedCosmeticRules {
    generic: Vec<String>,
    #[serde(rename = "domainSpecific")]
    domain_specific: HashMap<String, Vec<String>>,
}

#[derive(Serialize, Deserialize, Default)]
struct ActiveFilterIndex {
    cosmetic: ReducedCosmeticRules,
    scriptlets: Vec<ParsedRule>,
    #[serde(rename = "genericCss")]
    generic_css: String,
    #[serde(rename = "bloomHosts")]
    bloom_hosts: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct PageBundleRules {
    generic: Vec<String>,
    #[serde(rename = "domainSpecific")]
    domain_specific: Vec<PlannedSelectorRule>,
    exceptions: Vec<String>,
}

struct BuiltPageBundle {
    rules: PageBundleRules,
    css_text: String,
    exception_css: String,
    cosmetic_rules_binary: Vec<u8>,
}

struct FirstOp {
    base: String,
    op: String,
    arg: String,
    rest: String,
}

fn contains_proc_op(selector: &str) -> bool {
    proc_op_ac().is_match(selector)
}

fn find_matching_paren(selector: &str, start: usize) -> Option<usize> {
    let mut depth = 1;
    for (offset, ch) in selector[start..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(start + offset);
                }
            }
            _ => {}
        }
    }
    None
}

fn extract_first_op(selector: &str) -> Option<FirstOp> {
    let proc_ops = [
        "matches-css-before",
        "matches-css-after",
        "matches-css",
        "has-text",
        "nth-ancestor",
        "upward",
        "min-text-length",
        "xpath",
        "watch-attr",
        "remove",
        "style",
        "matches-path",
        "matches-attr",
        "if-not",
        "if",
        "semantic",
    ];

    let mut depth = 0i32;
    for (idx, ch) in selector.char_indices() {
        match ch {
            '(' => {
                depth += 1;
                continue;
            }
            ')' => {
                depth -= 1;
                continue;
            }
            ':' if depth == 0 => {}
            _ => continue,
        }

        let after_colon = idx + ch.len_utf8();
        for op in proc_ops {
            let needle = format!("{op}(");
            if selector[after_colon..].starts_with(&needle) {
                let base = selector[..idx].trim_end().to_string();
                let arg_start = after_colon + op.len() + 1;
                let close = find_matching_paren(selector, arg_start)?;
                let arg = selector[arg_start..close].to_string();
                let rest = selector[close + 1..].trim_start().to_string();
                return Some(FirstOp {
                    base,
                    op: op.to_string(),
                    arg,
                    rest,
                });
            }
        }
    }

    for pseudo in [":has(", ":not(", ":is(", ":where("] {
        if let Some(idx) = selector.find(pseudo) {
            let arg_start = idx + pseudo.len();
            let close = find_matching_paren(selector, arg_start)?;
            let inner = &selector[arg_start..close];
            if contains_proc_op(inner) {
                return Some(FirstOp {
                    base: selector[..idx].trim_end().to_string(),
                    op: pseudo[1..pseudo.len() - 1].to_string(),
                    arg: inner.to_string(),
                    rest: selector[close + 1..].trim_start().to_string(),
                });
            }
        }
    }

    None
}

fn parse_procedural_plan(selector: &str) -> Vec<ProceduralPlanStep> {
    let mut plan = Vec::new();
    let mut remaining = selector.trim().to_string();

    while !remaining.is_empty() {
        let Some(first) = extract_first_op(&remaining) else {
            plan.push(ProceduralPlanStep {
                step_type: "css".to_string(),
                selector: Some(remaining.trim().to_string()),
                op: None,
                arg: None,
            });
            break;
        };

        if !first.base.is_empty() {
            plan.push(ProceduralPlanStep {
                step_type: "css".to_string(),
                selector: Some(first.base),
                op: None,
                arg: None,
            });
        }

        plan.push(ProceduralPlanStep {
            step_type: "op".to_string(),
            selector: None,
            op: Some(first.op),
            arg: Some(first.arg),
        });

        remaining = first.rest;
    }

    plan
}

fn is_valid_selector(selector: &str) -> bool {
    let trimmed = selector.trim();
    !trimmed.is_empty() && !trimmed.contains('{') && !trimmed.contains('}') && !trimmed.contains(';')
}

fn has_balanced_selector_delimiters(selector: &str) -> bool {
    let mut bracket_depth = 0i32;
    let mut paren_depth = 0i32;
    let mut quoted: Option<char> = None;
    let mut escaped = false;

    for ch in selector.chars() {
        if escaped {
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if let Some(quote) = quoted {
            if ch == quote {
                quoted = None;
            }
            continue;
        }

        match ch {
            '"' | '\'' => quoted = Some(ch),
            '[' => bracket_depth += 1,
            ']' => {
                bracket_depth -= 1;
                if bracket_depth < 0 {
                    return false;
                }
            }
            '(' => paren_depth += 1,
            ')' => {
                paren_depth -= 1;
                if paren_depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }

    quoted.is_none() && bracket_depth == 0 && paren_depth == 0
}

fn has_invalid_universal_usage(selector: &str) -> bool {
    let chars: Vec<char> = selector.chars().collect();
    let mut bracket_depth = 0i32;
    let mut quoted: Option<char> = None;
    let mut escaped = false;

    for (idx, ch) in chars.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }

        if *ch == '\\' {
            escaped = true;
            continue;
        }

        if let Some(quote) = quoted {
            if *ch == quote {
                quoted = None;
            }
            continue;
        }

        match *ch {
            '"' | '\'' => {
                quoted = Some(*ch);
                continue;
            }
            '[' => {
                bracket_depth += 1;
                continue;
            }
            ']' => {
                bracket_depth -= 1;
                continue;
            }
            '*' if bracket_depth == 0 => {
                let prev = chars[..idx].iter().rev().find(|c| !c.is_whitespace());
                if prev.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == ')' || *c == ']') {
                    return true;
                }
            }
            _ => {}
        }
    }

    false
}

fn is_css_safe_selector(selector: &str) -> bool {
    let trimmed = selector.trim();
    is_valid_selector(trimmed)
        && !contains_proc_op(trimmed)
        && has_balanced_selector_delimiters(trimmed)
        && !has_invalid_universal_usage(trimmed)
}

fn build_css_from_selector_list(selectors: &[String], chunk_size: usize) -> String {
    let cap = if chunk_size == 0 { 100 } else { chunk_size };
    let mut seen = HashSet::new();
    let mut unique = Vec::new();

    for selector in selectors {
        let selector = selector.trim();
        if !is_css_safe_selector(selector) {
            continue;
        }
        if seen.insert(selector.to_string()) {
            unique.push(selector.to_string());
        }
    }

    let mut out = Vec::with_capacity(unique.len() / cap + 1);
    for chunk in unique.chunks(cap) {
        out.push(format!(
            "{} {{ display: none !important; visibility: hidden !important; }}",
            chunk.join(",")
        ));
    }
    out.join("\n")
}

fn serialize_rules_to_binary_lists(generic: &[String], domain_specific: &[String], exceptions: &[String]) -> Vec<u8> {
    let mut buffer = Vec::new();
    let write_list = |buf: &mut Vec<u8>, list: &[String]| {
        buf.extend_from_slice(&(list.len() as u32).to_le_bytes());
        for s in list {
            buf.extend_from_slice(s.as_bytes());
            buf.push(0);
        }
    };

    write_list(&mut buffer, generic);
    write_list(&mut buffer, domain_specific);
    write_list(&mut buffer, exceptions);
    buffer
}

fn build_page_bundle_internal(
    generic_in: Vec<String>,
    domain_specific_in: Vec<String>,
    exceptions_in: Vec<String>,
    css_chunk_size: usize,
) -> BuiltPageBundle {
    let mut exceptions = Vec::new();
    let mut exception_seen = HashSet::new();
    for selector in exceptions_in {
        let selector = selector.trim();
        if !is_css_safe_selector(selector) {
            continue;
        }
        if exception_seen.insert(selector.to_string()) {
            exceptions.push(selector.to_string());
        }
    }

    let exception_set: HashSet<&str> = exceptions.iter().map(String::as_str).collect();
    let mut css_selectors = Vec::new();
    let mut procedural_rules = Vec::new();

    for selector in generic_in.into_iter().chain(domain_specific_in.into_iter()) {
        let selector = selector.trim();
        if !is_valid_selector(selector) || exception_set.contains(selector) {
            continue;
        }

        if contains_proc_op(selector) {
            procedural_rules.push(PlannedSelectorRule {
                selector: selector.to_string(),
                plan: parse_procedural_plan(selector),
            });
        } else if is_css_safe_selector(selector) {
            css_selectors.push(selector.to_string());
        }
    }

    let css_text = build_css_from_selector_list(&css_selectors, css_chunk_size);
    let exception_css = if exceptions.is_empty() {
        String::new()
    } else {
        format!(
            "{} {{ display: revert !important; visibility: revert !important; }}",
            exceptions.join(",")
        )
    };

    let binary_domain_specific: Vec<String> = procedural_rules.iter()
        .filter_map(|rule| serde_json::to_string(rule).ok())
        .collect();

    let cosmetic_rules_binary = serialize_rules_to_binary_lists(&Vec::new(), &binary_domain_specific, &exceptions);

    BuiltPageBundle {
        rules: PageBundleRules {
            generic: Vec::new(),
            domain_specific: procedural_rules,
            exceptions,
        },
        css_text,
        exception_css,
        cosmetic_rules_binary,
    }
}

/// Batch-classify selectors and pre-plan procedural selectors for the content
/// script so it does not have to parse operator chains at page load.
#[wasm_bindgen]
pub fn plan_selector_rules_json(selectors_json: &str) -> String {
    let selectors: Vec<String> = serde_json::from_str(selectors_json).unwrap_or_default();
    let mut bundle = PlannedSelectorBundle::default();

    for selector in selectors {
        let selector = selector.trim();
        if !is_valid_selector(selector) {
            continue;
        }
        if contains_proc_op(selector) {
            bundle.procedural_rules.push(PlannedSelectorRule {
                selector: selector.to_string(),
                plan: parse_procedural_plan(selector),
            });
        } else if is_css_safe_selector(selector) {
            bundle.css_selectors.push(selector.to_string());
        }
    }

    serde_json::to_string(&bundle).unwrap_or_else(|_| "{\"cssSelectors\":[],\"proceduralRules\":[]}".to_string())
}

/// Build the per-page cosmetic bundle in one Rust pass:
/// - dedupe/validate exceptions
/// - split CSS-safe vs procedural selectors
/// - pre-plan procedural selectors
/// - build CSS text
/// - serialize the binary procedural payload for content scripts
#[wasm_bindgen]
pub fn build_page_bundle(
    generic: JsValue,
    domain_specific: JsValue,
    exceptions: JsValue,
    css_chunk_size: usize,
) -> JsValue {
    let generic_in: Vec<String> = from_js_value(generic);
    let domain_specific_in: Vec<String> = from_js_value(domain_specific);
    let exceptions_in: Vec<String> = from_js_value(exceptions);
    let bundle = build_page_bundle_internal(generic_in, domain_specific_in, exceptions_in, css_chunk_size);

    let bundle_obj = Object::new();
    let rules_obj = Object::new();

    let generic_js = Array::new();
    let domain_specific_js = serde_wasm_bindgen::to_value(&bundle.rules.domain_specific)
        .unwrap_or_else(|_| Array::new().into());
    let exceptions_js = serde_wasm_bindgen::to_value(&bundle.rules.exceptions)
        .unwrap_or_else(|_| Array::new().into());
    let binary_js = Uint8Array::from(bundle.cosmetic_rules_binary.as_slice());

    let _ = Reflect::set(&rules_obj, &JsValue::from_str("generic"), &generic_js.into());
    let _ = Reflect::set(&rules_obj, &JsValue::from_str("domainSpecific"), &domain_specific_js);
    let _ = Reflect::set(&rules_obj, &JsValue::from_str("exceptions"), &exceptions_js);

    let _ = Reflect::set(&bundle_obj, &JsValue::from_str("rules"), &rules_obj.into());
    let _ = Reflect::set(&bundle_obj, &JsValue::from_str("cssText"), &JsValue::from_str(&bundle.css_text));
    let _ = Reflect::set(&bundle_obj, &JsValue::from_str("exceptionCss"), &JsValue::from_str(&bundle.exception_css));
    let _ = Reflect::set(&bundle_obj, &JsValue::from_str("cosmeticRulesBinary"), &binary_js.into());

    bundle_obj.into()
}

// ---------------------------------------------------------------------------
// build_css_from_selectors — exception filtering + dedup + chunked CSS, one call
// ---------------------------------------------------------------------------

/// Build the final `display:none` CSS block from a newline-separated selector list,
/// filtering out exceptions and deduplicating. Chunks are capped at `chunk_size`
/// selectors to avoid hitting browser CSS parser limits.
///
/// Returns newline-separated CSS rules, one rule per chunk.
#[wasm_bindgen]
pub fn build_css_from_selectors(selectors: &str, exceptions: &str, chunk_size: usize) -> String {
    let exc: HashSet<&str> = exceptions.split('\n')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    let cap = if chunk_size == 0 { 100 } else { chunk_size };

    let mut seen: HashSet<&str> = HashSet::new();
    let unique: Vec<&str> = selectors.split('\n')
        .map(|s| s.trim())
        .filter(|s| {
            !s.is_empty()
            && !s.contains('{')
            && !s.contains('}')
            && !s.contains(';')
            && !exc.contains(*s)
            && seen.insert(*s)
        })
        .collect();

    let mut out = Vec::with_capacity(unique.len() / cap + 1);
    for chunk in unique.chunks(cap) {
        out.push(format!(
            "{} {{ display: none !important; visibility: hidden !important; }}",
            chunk.join(",")
        ));
    }
    out.join("\n")
}

// ---------------------------------------------------------------------------
// Stealth Noise
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn generate_gaussian_noise(mean: f64, std_dev: f64, seed: f64) -> f64 {
    // `Normal::new` rejects non-finite or negative std_dev. Guard first —
    // callers that pass 0 (noise disabled) or a bad seed should just get
    // the mean back rather than a WASM panic.
    if !std_dev.is_finite() || std_dev <= 0.0 || !mean.is_finite() {
        return mean;
    }
    match Normal::new(mean, std_dev) {
        Ok(dist) => {
            let mut rng = SmallRng::seed_from_u64(seed as u64);
            dist.sample(&mut rng)
        }
        Err(_) => mean,
    }
}

fn reduce_cosmetic_rules_internal(
    generic_in: Vec<String>,
    mut domain_map: HashMap<String, Vec<String>>,
    exceptions_map: HashMap<String, Vec<String>>,
) -> ReducedCosmeticRules {
    let mut generic = Vec::new();
    let mut generic_seen = HashSet::new();
    for selector in generic_in {
        let selector = selector.trim();
        if !is_valid_selector(selector) {
            continue;
        }
        if generic_seen.insert(selector.to_string()) {
            generic.push(selector.to_string());
        }
    }

    let generic_set: HashSet<&str> = generic.iter().map(String::as_str).collect();
    for selectors in domain_map.values_mut() {
        let mut deduped = Vec::new();
        let mut seen = HashSet::new();
        for selector in selectors.iter() {
            let selector = selector.trim();
            if !is_valid_selector(selector) || generic_set.contains(selector) {
                continue;
            }
            if seen.insert(selector.to_string()) {
                deduped.push(selector.to_string());
            }
        }
        *selectors = deduped;
    }

    for (domain, selectors) in exceptions_map {
        let entry = domain_map.entry(domain).or_default();
        let mut seen: HashSet<String> = entry.iter().cloned().collect();
        for selector in selectors {
            let selector = selector.trim();
            if !is_valid_selector(selector) {
                continue;
            }
            let prefixed = format!("__exception__{selector}");
            if seen.insert(prefixed.clone()) {
                entry.push(prefixed);
            }
        }
    }

    domain_map.retain(|_, selectors| !selectors.is_empty());

    ReducedCosmeticRules {
        generic,
        domain_specific: domain_map,
    }
}

fn compile_active_filter_index_internal(
    core_source: FilterSourceBundle,
    list_sources: Vec<FilterSourceBundle>,
    css_chunk_size: usize,
) -> ActiveFilterIndex {
    let mut merged_generic = Vec::new();
    let mut generic_seen = HashSet::new();
    let mut merged_domains: HashMap<String, Vec<String>> = HashMap::new();
    let mut domain_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut merged_exceptions: HashMap<String, Vec<String>> = HashMap::new();
    let mut exception_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut merged_scriptlets = Vec::new();
    let mut scriptlet_seen = HashSet::new();

    let mut merge_source = |source: FilterSourceBundle| {
        for selector in source.cosmetic.generic {
            push_unique(&mut merged_generic, &mut generic_seen, &selector);
        }

        for (domain, selectors) in source.cosmetic.domain_specific {
            for selector in selectors {
                push_unique_domain_selector(
                    &mut merged_domains,
                    &mut domain_seen,
                    &domain,
                    &selector,
                );
            }
        }

        for (domain, selectors) in source.cosmetic.exceptions {
            for selector in selectors {
                push_unique_domain_selector(
                    &mut merged_exceptions,
                    &mut exception_seen,
                    &domain,
                    &selector,
                );
            }
        }

        for rule in source.scriptlets {
            let fingerprint = scriptlet_fingerprint(&rule);
            if scriptlet_seen.insert(fingerprint) {
                merged_scriptlets.push(rule);
            }
        }
    };

    merge_source(core_source);
    for source in list_sources {
        merge_source(source);
    }

    let cosmetic = reduce_cosmetic_rules_internal(
        merged_generic,
        merged_domains,
        merged_exceptions,
    );

    let mut bloom_hosts: Vec<String> = cosmetic.domain_specific.keys().cloned().collect();
    let mut bloom_seen: HashSet<String> = bloom_hosts.iter().cloned().collect();
    for rule in &merged_scriptlets {
        for domain in &rule.domains {
            let domain = domain.trim().to_lowercase();
            if domain.is_empty() {
                continue;
            }
            if bloom_seen.insert(domain.clone()) {
                bloom_hosts.push(domain);
            }
        }
    }

    if (!cosmetic.generic.is_empty() || merged_scriptlets.iter().any(|rule| rule.domains.is_empty()))
        && bloom_seen.insert(String::new())
    {
        bloom_hosts.push(String::new());
    }

    let generic_css = build_page_bundle_internal(
        cosmetic.generic.clone(),
        Vec::new(),
        Vec::new(),
        css_chunk_size,
    ).css_text;

    ActiveFilterIndex {
        cosmetic,
        scriptlets: merged_scriptlets,
        generic_css,
        bloom_hosts,
    }
}

#[wasm_bindgen]
pub fn compile_active_filter_index(core_source: JsValue, list_sources: JsValue, css_chunk_size: usize) -> JsValue {
    let core_source: FilterSourceBundle = from_js_value(core_source);
    let list_sources: Vec<FilterSourceBundle> = from_js_value(list_sources);
    to_js_value(&compile_active_filter_index_internal(core_source, list_sources, css_chunk_size))
}

// ---------------------------------------------------------------------------
// CSS Selector Sanitizer & Compactor
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn sanitize_and_compact_selectors(csv: &str, chunk_size: usize) -> String {
    let selectors: Vec<String> = csv.split('\n')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    build_css_from_selector_list(&selectors, chunk_size)
}

// ---------------------------------------------------------------------------
// Binary Rule Transfer
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn serialize_rules_to_binary_from_json(generic_json: &str, domain_specific_json: &str, exceptions_json: &str) -> Vec<u8> {
    let generic: Vec<String> = serde_json::from_str(generic_json).unwrap_or_default();
    let domain_specific: Vec<String> = serde_json::from_str(domain_specific_json).unwrap_or_default();
    let exceptions: Vec<String> = serde_json::from_str(exceptions_json).unwrap_or_default();
    serialize_rules_to_binary_lists(&generic, &domain_specific, &exceptions)
}

// ---------------------------------------------------------------------------
// Differential Privacy Reporter
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn anonymize_stats_json(json: &str, noise_scale: f64, seed: f64) -> String {
    let mut data: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    // Skip noise injection entirely when `noise_scale` is nonpositive or
    // non-finite rather than panicking inside `Normal::new`.
    let dist = if noise_scale.is_finite() && noise_scale > 0.0 {
        Normal::new(0.0, noise_scale).ok()
    } else {
        None
    };
    let mut rng = SmallRng::seed_from_u64(seed as u64);

    if let Some(obj) = data.as_object_mut() {
        for (_key, value) in obj.iter_mut() {
            if let Some(count) = value.as_f64() {
                let noise = dist.as_ref().map(|d| d.sample(&mut rng)).unwrap_or(0.0);
                let anonymized = (count + noise).max(0.0).round();
                *value = serde_json::json!(anonymized);
            }
        }
    }

    data.to_string()
}

// ---------------------------------------------------------------------------
// Entity-Resolution Engine
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn resolve_entity(hostname: &str) -> String {
    let mut d = hostname;
    loop {
        let entity = match d {
            "google.com" | "doubleclick.net" | "googlesyndication.com" | "google-analytics.com" | "gstatic.com" | "googleadservices.com" | "2mdn.net" => "Google",
            "facebook.com" | "facebook.net" | "fbcdn.net" | "fbsbx.com" | "fbevents.com" | "messenger.com" | "instagram.com" => "Meta",
            "amazon-adsystem.com" | "media-amazon.com" | "assoc-amazon.com" => "Amazon",
            "bing.com" | "msn.com" | "live.com" | "ads.microsoft.com" | "clarity.ms" | "azureedge.net" => "Microsoft",
            "twitter.com" | "x.com" | "t.co" | "twimg.com" => "X (Twitter)",
            "tiktok.com" | "byteoversea.com" | "ibyteimg.com" | "tiktokv.com" => "TikTok",
            "adnxs.com" | "appnexus.com" => "AppNexus (Xandr)",
            "rubiconproject.com" | "magnite.com" => "Magnite",
            "adsrvr.org" => "The Trade Desk",
            "criteo.com" | "criteo.net" => "Criteo",
            "taboola.com" => "Taboola",
            "outbrain.com" => "Outbrain",
            "pubmatic.com" => "PubMatic",
            "casalemedia.com" | "indexww.com" => "Index Exchange",
            "openx.net" => "OpenX",
            "demdex.net" | "omtrdc.net" | "adobe.com" | "everesttech.net" => "Adobe",
            "bluekai.com" | "addthis.com" | "oracle.com" => "Oracle",
            "krxd.net" | "salesforce.com" => "Salesforce",
            "scorecardresearch.com" | "comscore.com" => "Comscore",
            "quantserve.com" | "quantcount.com" => "Quantcast",
            "hotjar.com" => "Hotjar",
            "nr-data.net" | "newrelic.com" => "New Relic",
            "sentry.io" | "ingest.sentry.io" => "Sentry",
            "cloudfront.net" => "Amazon (AWS)",
            "akamaihd.net" | "akamaized.net" | "edgekey.net" => "Akamai",
            "fastly.net" => "Fastly",
            "cloudflare.com" => "Cloudflare",
            _ => "",
        };

        if !entity.is_empty() {
            return entity.to_string();
        }

        match d.find('.') {
            Some(idx) => d = &d[idx + 1..],
            None => break,
        }
    }
    "".to_string()
}

// ---------------------------------------------------------------------------
// YouTube High-Performance JSON Neutralizer
// OnceLock statics: AhoCorasick automata built once, reused on every call.
// ---------------------------------------------------------------------------

const YT_POISON_FLAGS: &[&str] = &[
    "\"web_player_api_v2_server_side_ad_injection\":true",
    "\"web_enable_ab_wv_edu\":true",
    "\"web_enable_ad_signals\":true",
    "\"web_player_api_v2_ad_break_heartbeat_params\":true",
    "\"web_disable_midroll_ads\":false",
    "\"web_enable_ab_wv_edu_v2\":true",
    "\"web_enable_ab_wv_edu_v3\":true",
    "\"web_player_api_v2_ads_metadata\":true",
    "\"web_enable_ad_break_heartbeat\":true",
];
const YT_CLEAN_FLAGS: &[&str] = &[
    "\"web_player_api_v2_server_side_ad_injection\":false",
    "\"web_enable_ab_wv_edu\":false",
    "\"web_enable_ad_signals\":false",
    "\"web_player_api_v2_ad_break_heartbeat_params\":false",
    "\"web_disable_midroll_ads\":true",
    "\"web_enable_ab_wv_edu_v2\":false",
    "\"web_enable_ab_wv_edu_v3\":false",
    "\"web_player_api_v2_ads_metadata\":false",
    "\"web_enable_ad_break_heartbeat\":false",
];

// Flat combined pattern/replacement tables for the single-pass combined automaton.
// Indices 0..5 = ad keys, 5..14 = experiment poison flags.
const YT_ALL_PATTERNS: &[&str] = &[
    "\"adPlacements\":",
    "\"adSlots\":",
    "\"playerAds\":",
    "\"adBreakHeartbeatParams\":",
    "\"adClientParams\":",
    "\"web_player_api_v2_server_side_ad_injection\":true",
    "\"web_enable_ab_wv_edu\":true",
    "\"web_enable_ad_signals\":true",
    "\"web_player_api_v2_ad_break_heartbeat_params\":true",
    "\"web_disable_midroll_ads\":false",
    "\"web_enable_ab_wv_edu_v2\":true",
    "\"web_enable_ab_wv_edu_v3\":true",
    "\"web_player_api_v2_ads_metadata\":true",
    "\"web_enable_ad_break_heartbeat\":true",
];
const YT_ALL_REPLACEMENTS: &[&str] = &[
    "\"adPlacements\":false,\"disabled_adPlacements\":",
    "\"adSlots\":false,\"disabled_adSlots\":",
    "\"playerAds\":false,\"disabled_playerAds\":",
    "\"adBreakHeartbeatParams\":false,\"disabled_adBreakHeartbeatParams\":",
    "\"adClientParams\":false,\"disabled_adClientParams\":",
    "\"web_player_api_v2_server_side_ad_injection\":false",
    "\"web_enable_ab_wv_edu\":false",
    "\"web_enable_ad_signals\":false",
    "\"web_player_api_v2_ad_break_heartbeat_params\":false",
    "\"web_disable_midroll_ads\":true",
    "\"web_enable_ab_wv_edu_v2\":false",
    "\"web_enable_ab_wv_edu_v3\":false",
    "\"web_player_api_v2_ads_metadata\":false",
    "\"web_enable_ad_break_heartbeat\":false",
];
/// Single automaton covering all 14 patterns — built once, reused forever.
/// Replaces separate yt_ad_ac / yt_exp_ac in the hot path, cutting scans from 4 → 2.
fn yt_combined_ac() -> &'static AhoCorasick {
    static AC: OnceLock<AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| AhoCorasick::new(YT_ALL_PATTERNS).unwrap())
}

fn yt_exp_ac() -> &'static AhoCorasick {
    static AC: OnceLock<AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| AhoCorasick::new(YT_POISON_FLAGS).unwrap())
}

/// Combined single-pass processor: neutralizes ad keys AND flips experiment flags.
///
/// Uses a single merged AhoCorasick automaton (yt_combined_ac) so the text is
/// scanned twice at most — once for the fast-path `is_match` check and once for
/// the actual replacement — instead of the previous four-scan, two-allocation
/// approach.
///
/// Returns an **empty string** when the text needs no changes. The JS caller
/// must treat that as "use the original text" to avoid a pointless 500 KB
/// copy-out across the WASM boundary on every clean (ad-free) response.
///
/// We keep the original ad keys present but set them to `false`, while moving
/// the original payload behind a `disabled_` prefix. This preserves the schema
/// YouTube expects without leaving active ad data in place.
#[wasm_bindgen]
pub fn process_youtube_player(text: &str) -> String {
    // Single combined pre-check: one O(n) scan over all 14 patterns.
    // Returns "" → JS keeps its own copy of the text, no copy-out needed.
    if !yt_combined_ac().is_match(text) {
        return String::new();
    }

    // Single replacement pass: ad-key neutralization AND experiment-flag flips
    // in one O(n) walk — no intermediate buffer, no second allocation.
    let mut result = String::with_capacity(text.len());
    yt_combined_ac().replace_all_with(text, &mut result, |mat, _, dst| {
        dst.push_str(YT_ALL_REPLACEMENTS[mat.pattern().as_usize()]);
        true
    });
    result
}

#[wasm_bindgen]
pub fn sanitize_youtube_experiments(json_text: &str) -> String {
    let mut result = String::with_capacity(json_text.len());
    yt_exp_ac().replace_all_with(json_text, &mut result, |mat, _, dst| {
        dst.push_str(YT_CLEAN_FLAGS[mat.pattern().as_usize()]);
        true
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_youtube_player_keeps_keys_but_neutralizes_values() {
        let input = concat!(
            "{\"adPlacements\":[{\"slot\":1}],",
            "\"playerAds\":{\"ad\":\"yes\"},",
            "\"web_disable_midroll_ads\":false,",
            "\"web_enable_ad_break_heartbeat\":true}"
        );

        let output = process_youtube_player(input);

        assert!(output.contains("\"adPlacements\":false,\"disabled_adPlacements\":["));
        assert!(output.contains("\"playerAds\":false,\"disabled_playerAds\":{"));
        assert!(output.contains("\"web_disable_midroll_ads\":true"));
        assert!(output.contains("\"web_enable_ad_break_heartbeat\":false"));
    }

    #[test]
    fn process_youtube_player_skips_clean_payloads() {
        assert_eq!(process_youtube_player("{\"streamingData\":{}}"), "");
    }

    #[test]
    fn plan_selector_rules_separates_css_and_procedural() {
        let planned = plan_selector_rules_json(
            "[\".ad-slot\",\"div:has-text(Sponsored):upward(article)\"]"
        );
        let parsed: serde_json::Value = serde_json::from_str(&planned).unwrap();

        assert_eq!(parsed["cssSelectors"][0], ".ad-slot");
        assert_eq!(parsed["proceduralRules"][0]["selector"], "div:has-text(Sponsored):upward(article)");
        assert_eq!(parsed["proceduralRules"][0]["plan"][0]["type"], "css");
        assert_eq!(parsed["proceduralRules"][0]["plan"][1]["type"], "op");
    }

    #[test]
    fn reduce_cosmetic_rules_folds_exceptions_and_drops_generic_duplicates() {
        let reduced = reduce_cosmetic_rules_internal(
            vec![".global-ad".into(), ".global-ad".into(), ".hero-ad".into()],
            HashMap::from([(
                "example.com".to_string(),
                vec![".hero-ad".to_string(), ".sidebar-ad".to_string(), ".sidebar-ad".to_string()],
            )]),
            HashMap::from([(
                "example.com".to_string(),
                vec![".allow-me".to_string()],
            )]),
        );

        assert_eq!(reduced.generic.len(), 2);
        assert_eq!(reduced.domain_specific["example.com"][0], ".sidebar-ad");
        assert_eq!(reduced.domain_specific["example.com"][1], "__exception__.allow-me");
    }

    #[test]
    fn build_page_bundle_internal_splits_css_and_procedural_once() {
        let bundle = build_page_bundle_internal(
            vec![".hero-ad".into(), ".allow-me".into()],
            vec!["div:has-text(Sponsored):upward(article)".into()],
            vec![".allow-me".into(), ".allow-me".into()],
            150,
        );

        assert!(bundle.css_text.contains(".hero-ad"));
        assert!(!bundle.css_text.contains(".allow-me"));
        assert_eq!(bundle.rules.domain_specific.len(), 1);
        assert_eq!(bundle.rules.domain_specific[0].selector, "div:has-text(Sponsored):upward(article)");
        assert_eq!(bundle.rules.exceptions, vec![".allow-me".to_string()]);
        assert!(bundle.exception_css.contains(".allow-me"));
        assert!(bundle.cosmetic_rules_binary.len() > 12);
    }

    #[test]
    fn compile_user_filters_batches_network_cosmetic_and_scriptlets() {
        let compiled = compile_user_filters_internal(
            concat!(
                "||ads.example^\n",
                "||ads.example^\n",
                "example.com##.hero-ad\n",
                "example.com#@#.allow-ad\n",
                "##.global-ad\n",
                "##+js(set-constant, ads.enabled, false)\n",
                "example.com#?#div:has(.sponsor)\n",
            ),
            900000,
        );

        assert_eq!(compiled.dnr_rules.len(), 1);
        assert_eq!(compiled.cosmetic_rules.generic, vec![".global-ad".to_string()]);
        assert_eq!(
            compiled.cosmetic_rules.domain_specific["example.com"],
            vec![".hero-ad".to_string(), "div:has(.sponsor)".to_string()]
        );
        assert_eq!(
            compiled.cosmetic_rules.domain_exceptions["example.com"],
            vec![".allow-ad".to_string()]
        );
        assert_eq!(compiled.scriptlet_rules.len(), 1);
    }

    #[test]
    fn merge_filter_sources_preserves_bundled_priority_and_folds_exceptions() {
        let merged = merge_filter_sources_internal(
            vec![".global-ad".into()],
            HashMap::from([("example.com".to_string(), vec![".hero-ad".to_string()])]),
            vec![ParsedRule {
                rule_type: "scriptlet".into(),
                domains: vec!["example.com".into()],
                selector: None,
                exception: None,
                name: Some("abort-current-script".into()),
                args: Some(vec!["ads".into()]),
            }],
            vec![concat!(
                "##.global-ad\n",
                "example.com##.hero-ad\n",
                "example.com##.sidebar-ad\n",
                "example.com#@#.sidebar-ad\n",
                "example.com##+js(abort-current-script, ads)\n",
                "news.example.com##.sponsor\n"
            )
            .to_string()],
        );

        assert_eq!(merged.generic, vec![".global-ad".to_string()]);
        assert_eq!(
            merged.domain_specific["example.com"],
            vec![".hero-ad".to_string(), ".sidebar-ad".to_string(), "__exception__.sidebar-ad".to_string()]
        );
        assert_eq!(
            merged.domain_specific["news.example.com"],
            vec![".sponsor".to_string()]
        );
        assert_eq!(merged.scriptlet_rules.len(), 1);
    }

    #[test]
    fn build_allowlist_rules_dedupes_and_normalizes_domains() {
        let rules = build_allowlist_rules_internal(
            vec![" Example.com ".into(), "example.com".into(), "news.example.com".into()],
            990000,
        );

        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].id, 990000);
        assert_eq!(rules[0].priority, 500);
        assert_eq!(rules[0].condition.url_filter.as_deref(), Some("||example.com^"));
        assert_eq!(rules[1].condition.url_filter.as_deref(), Some("||news.example.com^"));
    }

    #[test]
    fn compile_active_filter_index_skips_invalid_and_procedural_generic_css() {
        let compiled = compile_active_filter_index_internal(
            FilterSourceBundle {
                cosmetic: FilterSourceCosmetic {
                    generic: vec![
                        ".ad".to_string(),
                        "#google_ads_iframe_*".to_string(),
                        ".ad-slot-header:remove()".to_string(),
                    ],
                    domain_specific: HashMap::new(),
                    exceptions: HashMap::new(),
                },
                scriptlets: Vec::new(),
            },
            Vec::new(),
            100,
        );

        assert!(compiled.generic_css.contains(".ad"));
        assert!(!compiled.generic_css.contains("#google_ads_iframe_*"));
        assert!(!compiled.generic_css.contains(":remove("));
    }
}

// ---------------------------------------------------------------------------
// Semantic Hiding Engine
// ---------------------------------------------------------------------------

fn ad_keyword_ac() -> &'static AhoCorasick {
    static AC: OnceLock<AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| AhoCorasick::new([
        "sponsored", "promoted", "advertisement", "adsby", "suggestedpost",
        "recommendedforyou", "marketingshare", "sponsoredpost", "paidpost",
        "publicidad", "patrocinado", "anuncio",
        "anzeige", "gesponsert",
        "publicit", "sponsoris",
        "pubblicit", "sponsorizzato",
        "reklama", "sponsorowane",
    ]).unwrap())
}

#[wasm_bindgen]
pub fn is_semantic_ad(text: &str) -> bool {
    // Normalize once, then do a single O(n) multi-pattern scan.
    let normalized: String = text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    if normalized.is_empty() { return false; }
    ad_keyword_ac().is_match(&normalized)
}
