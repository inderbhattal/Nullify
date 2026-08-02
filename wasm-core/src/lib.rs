use aho_corasick::AhoCorasick;
use js_sys::{Array, Object, Reflect, Uint8Array};
use rand::prelude::*;
use rand::rngs::SmallRng;
use rand_distr::{Distribution, Normal};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;

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
// PSL is generated from src/shared/psl.js to ensure JS/Rust sync
mod psl_generated;

fn public_suffixes() -> &'static HashSet<&'static str> {
    psl_generated::public_suffixes_generated()
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

/// Upper bound on a Bloom filter's bit count: 128 Mbit, i.e. a 16 MB bitset.
///
/// Far above any real use — the shipped filter is 256 Kbit — while keeping the
/// word count well inside 32-bit arithmetic, so the size maths cannot overflow
/// on wasm32 no matter what a stored payload declares.
const MAX_BLOOM_BITS: usize = 1 << 27;

/// Serialization format tag written by both the JS and Rust serializers.
///
/// Format 1 means "bit indices come from the 32-bit FNV-1a variant in
/// src/shared/bloom.js". A payload without the field is a legacy one — it is
/// accepted, because legacy JS payloads used the same hash. A payload with an
/// *unknown* format is refused (safe empty fallback) so a future format change
/// degrades to a rebuild instead of silently cross-loading incompatible bits.
/// Keep in sync with `BLOOM_FORMAT` in src/shared/bloom.js.
const BLOOM_FORMAT: u32 = 1;

#[wasm_bindgen]
impl BloomFilter {
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize, hashes: u8) -> Self {
        // Clamp to a sane range. Zero makes `add`/`has` divide by zero
        // (`hash % size`) and a zero hash count makes membership meaningless;
        // an absurd upper value allocates hundreds of megabytes inside a
        // service worker whose heap is small.
        let size = size.clamp(1, MAX_BLOOM_BITS);
        let hashes = hashes.max(1);
        // div_ceil, not `(size + 31) / 32`: on wasm32 `usize` is 32-bit and
        // release builds wrap, so the old form folded a near-u32::MAX size
        // down to a zero-length bitset that `has()` then indexed.
        let bitset_size = size.div_ceil(32);
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

    /// Bit-identical port of `BloomFilter._hash` in src/shared/bloom.js.
    ///
    /// The two engines cross-load each other's serialized filters, so the two
    /// hashes must agree bit for bit or every non-empty key maps to different
    /// bits and `has()` returns false for ~99% of domains (§4.1). JS iterates
    /// UTF-16 code units (`charCodeAt`), so we do too — for the ASCII
    /// hostnames actually stored the units equal the UTF-8 bytes, and for
    /// anything else `encode_utf16` still matches JS exactly. All arithmetic
    /// is wrapping u32, which is congruent mod 2^32 with JS's int32 shifts
    /// followed by the final `>>> 0`.
    fn calculate_hash(&self, key: &str, seed: u8) -> u32 {
        let mut h: u32 = 0x811c9dc5 ^ (seed as u32);
        for unit in key.encode_utf16() {
            h ^= unit as u32;
            h = h.wrapping_add(
                (h << 1)
                    .wrapping_add(h << 4)
                    .wrapping_add(h << 7)
                    .wrapping_add(h << 8)
                    .wrapping_add(h << 24),
            );
        }
        h
    }

    pub fn serialize_to_json(&self) -> Result<String, JsValue> {
        let s = SerializedBloom {
            format: Some(BLOOM_FORMAT),
            size: self.size,
            hashes: self.hashes,
            data: self.bitset.clone(),
        };
        serde_json::to_string(&s)
            .map_err(|e| JsValue::from_str(&format!("Bloom serialize error: {}", e)))
    }

    pub fn deserialize_from_json(json: &str) -> Self {
        // Fall back to an empty filter on malformed input rather than
        // panicking through WASM — a corrupt stored bloom filter should
        // degrade gracefully, not crash the whole rule pipeline.
        // Validate the semantic invariants too, not just JSON well-formedness:
        // a non-zero size/hashes and a bitset whose length exactly matches the
        // declared size. Otherwise `add`/`has` panic (divide-by-zero on
        // `size == 0`, out-of-bounds on a short `data`), poisoning the whole
        // WASM instance. Degrade to a safe empty filter instead.
        match serde_json::from_str::<SerializedBloom>(json) {
            Ok(s)
                if matches!(s.format, None | Some(BLOOM_FORMAT))
                    && s.size > 0
                    && s.size <= MAX_BLOOM_BITS
                    && s.hashes > 0
                    && s.data.len() == s.size.div_ceil(32) =>
            {
                Self {
                    size: s.size,
                    hashes: s.hashes,
                    bitset: s.data,
                }
            }
            _ => Self::new(1, 1),
        }
    }

    pub fn check_hostname(&self, hostname: &str) -> bool {
        if self.has("") {
            return true;
        }
        let mut d = hostname;
        loop {
            if is_public_suffix(d) {
                break;
            }
            if self.has(d) {
                return true;
            }
            match d.find('.') {
                Some(idx) => d = &d[idx + 1..],
                None => break,
            }
        }
        false
    }

    /// Returns the fill ratio of the bloom filter (set bits / total bits).
    /// A ratio > 0.5 indicates saturation and the filter should be rebuilt larger.
    #[wasm_bindgen]
    pub fn fill_ratio(&self) -> f64 {
        let set_bits = self.count_set_bits();
        set_bits as f64 / self.size as f64
    }

    /// Returns the fill ratio threshold at which the bloom filter should be rebuilt.
    #[wasm_bindgen]
    pub fn fill_threshold() -> f64 {
        0.5
    }

    fn count_set_bits(&self) -> usize {
        self.bitset.iter().map(|w| w.count_ones() as usize).sum()
    }
}

#[derive(Serialize, Deserialize)]
struct SerializedBloom {
    /// Hash/format version tag. Absent on legacy payloads, which are accepted
    /// because they were produced by the identical JS hash. See BLOOM_FORMAT.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format: Option<u32>,
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

// `#[serde(default)]` on the structs that cross the JS boundary via
// `from_js_value` (§5.21): a stored bundle missing one field must degrade to
// the field's default instead of hard-failing the whole compile and silently
// reverting to the slower JS merge path.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct FilterSourceCosmetic {
    generic: Vec<String>,
    #[serde(rename = "domainSpecific")]
    domain_specific: HashMap<String, Vec<String>>,
    exceptions: HashMap<String, Vec<String>>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct FilterSourceBundle {
    cosmetic: FilterSourceCosmetic,
    scriptlets: Vec<ParsedRule>,
}

fn from_js_value<T>(value: JsValue) -> Result<T, JsValue>
where
    T: for<'de> Deserialize<'de> + Default,
{
    serde_wasm_bindgen::from_value(value)
        .map_err(|e| JsValue::from_str(&format!("Deserialization error: {}", e)))
}

fn to_js_value<T>(value: &T) -> JsValue
where
    T: Serialize,
{
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .unwrap_or(JsValue::NULL)
}

// ---------------------------------------------------------------------------
// Input-size caps (§5.20). WASM linear memory never shrinks, so a single
// oversized call permanently balloons the instance; unbounded text inputs are
// also a trivial DoS through a hostile filter list. Each cap is far above the
// largest legitimate payload seen in practice.
// ---------------------------------------------------------------------------

/// My-Filters text typed/pasted by the user (real lists are a few KB).
const MAX_USER_FILTER_BYTES: usize = 2 * 1024 * 1024;
/// A fetched filter list (EasyList raw is ~2.5 MB).
const MAX_FILTER_SOURCE_BYTES: usize = 16 * 1024 * 1024;
/// A YouTube player JSON response (typically well under 4 MB).
const MAX_YT_PLAYER_BYTES: usize = 32 * 1024 * 1024;
/// Total selector/scriptlet entries across all sources fed to the index
/// compiler (the shipped corpus is ~45k selectors).
const MAX_INDEX_INPUT_ENTRIES: usize = 1_000_000;

/// Refuse an oversized input with a structured, machine-readable error.
fn check_input_size(function: &str, unit: &str, actual: usize, max: usize) -> Result<(), String> {
    if actual > max {
        Err(format!(
            "{{\"error\":\"input_too_large\",\"function\":\"{function}\",\"{unit}\":{actual},\"max\":{max}}}"
        ))
    } else {
        Ok(())
    }
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

fn should_skip_domain_cosmetic_selector(domain: &str, selector: &str) -> bool {
    let domain = domain.trim().to_ascii_lowercase();
    let selector = selector.trim();
    matches!(
        (domain.as_str(), selector),
        ("mail.google.com", ".nH.PS")
            | ("mail.google.com", ".aeF > .nH > .nH[role=\"main\"] > .aKB")
    )
}

fn push_unique_domain_selector(
    map: &mut HashMap<String, Vec<String>>,
    seen_map: &mut HashMap<String, HashSet<String>>,
    domain: &str,
    selector: &str,
) {
    let domain = domain.trim().to_lowercase();
    let selector = selector.trim();
    if domain.is_empty()
        || should_skip_domain_cosmetic_selector(&domain, selector)
        || !is_valid_selector(selector)
    {
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

fn compile_user_filters_checked(text: &str, start_id: u32) -> Result<CompiledUserFilters, String> {
    check_input_size(
        "compile_user_filters",
        "bytes",
        text.len(),
        MAX_USER_FILTER_BYTES,
    )?;
    Ok(compile_user_filters_internal(text, start_id))
}

#[wasm_bindgen]
pub fn compile_user_filters(text: &str, start_id: u32) -> Result<JsValue, JsValue> {
    let compiled =
        compile_user_filters_checked(text, start_id).map_err(|e| JsValue::from_str(&e))?;
    Ok(to_js_value(&compiled))
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

    merged
        .domain_specific
        .retain(|_, selectors| !selectors.is_empty());
    merged
}

fn parse_filter_source_checked(text: &str) -> Result<FilterSourceBundle, String> {
    check_input_size(
        "parse_filter_source",
        "bytes",
        text.len(),
        MAX_FILTER_SOURCE_BYTES,
    )?;
    Ok(parse_filter_source_internal(text))
}

#[wasm_bindgen]
pub fn parse_filter_source(text: &str) -> Result<JsValue, JsValue> {
    let bundle = parse_filter_source_checked(text).map_err(|e| JsValue::from_str(&e))?;
    Ok(to_js_value(&bundle))
}

fn parse_filter_source_internal(text: &str) -> FilterSourceBundle {
    let mut bundle = FilterSourceBundle::default();
    let mut generic_seen = HashSet::new();
    let mut domain_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut exception_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut scriptlet_seen = HashSet::new();
    let mut scriptlet_exceptions: Vec<ParsedRule> = Vec::new();

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
            "scriptlet-exception" => {
                scriptlet_exceptions.push(rule);
            }
            "cosmetic" => {
                let Some(selector) = rule.selector.as_deref() else {
                    continue;
                };
                let is_exception = rule.exception.unwrap_or(false);

                if rule.domains.is_empty() {
                    if !is_exception {
                        push_unique(&mut bundle.cosmetic.generic, &mut generic_seen, selector);
                        // "everywhere except these": a generic rule plus an
                        // exception on each excluded domain. Lookup already
                        // gathers exceptions across the ancestor walk and
                        // subtracts them, so this needs no new bundle field.
                        for domain in &rule.excluded_domains {
                            push_unique_domain_selector(
                                &mut bundle.cosmetic.exceptions,
                                &mut exception_seen,
                                domain,
                                selector,
                            );
                        }
                    }
                    continue;
                }

                for domain in &rule.domains {
                    if is_exception {
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

                // A scoped rule carries its exclusions too: the lookup walk
                // reaches the excluded subdomain through its parent, so the
                // exception is what cancels it there.
                if !is_exception {
                    for domain in &rule.excluded_domains {
                        push_unique_domain_selector(
                            &mut bundle.cosmetic.exceptions,
                            &mut exception_seen,
                            domain,
                            selector,
                        );
                    }
                }
            }
            _ => {}
        }
    }

    apply_scriptlet_exceptions(&mut bundle.scriptlets, &scriptlet_exceptions);
    bundle
}

/// Apply `#@#+js(name)` exceptions to the collected scriptlets.
///
/// An exception naming domains excludes the scriptlet there; a domain-less one
/// disables it outright. Expressed as exclusions on the rule so the same
/// lookup-time filter that handles `~domain` cancels it, rather than a second
/// subtraction path that could drift. Mirrors `applyScriptletExceptions` in
/// src/shared/filter-syntax.js.
fn apply_scriptlet_exceptions(scriptlets: &mut Vec<ParsedRule>, exceptions: &[ParsedRule]) {
    if exceptions.is_empty() {
        return;
    }

    let mut global_kills: HashSet<&str> = HashSet::new();
    let mut per_domain: HashMap<&str, Vec<&str>> = HashMap::new();

    for exception in exceptions {
        let Some(name) = exception.name.as_deref() else {
            continue;
        };
        if exception.domains.is_empty() {
            global_kills.insert(name);
        } else {
            per_domain
                .entry(name)
                .or_default()
                .extend(exception.domains.iter().map(String::as_str));
        }
    }

    scriptlets.retain(|rule| {
        rule.name
            .as_deref()
            .is_none_or(|name| !global_kills.contains(name))
    });

    for rule in scriptlets.iter_mut() {
        let Some(name) = rule.name.as_deref() else {
            continue;
        };
        let Some(excepted) = per_domain.get(name) else {
            continue;
        };
        for domain in excepted {
            if !rule.excluded_domains.iter().any(|d| d == domain) {
                rule.excluded_domains.push((*domain).to_string());
            }
        }
    }
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
pub fn build_allowlist_rules(allowlist: JsValue, start_id: u32) -> Result<JsValue, JsValue> {
    let allowlist: Vec<String> = from_js_value(allowlist)?;
    Ok(to_js_value(&build_allowlist_rules_internal(
        allowlist, start_id,
    )))
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct ParsedRule {
    #[serde(rename = "type")]
    rule_type: String,
    domains: Vec<String>,
    /// Domains a `~`-prefixed entry excluded. Kept separate from `domains`
    /// because folding the two together inverts the rule's meaning. Named to
    /// match the JS parsers, which emit the same field.
    #[serde(
        rename = "excludedDomains",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    excluded_domains: Vec<String>,
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
    // `#@#+js(` must be recognised before any `+js(` test: it *contains*
    // `#+js(`, so the scriptlet branch claimed it first and produced an active
    // scriptlet under the garbage domain prefix "example.com#@" — the opposite
    // of disabling it.
    if let Some(idx) = line.find("#@#+js(") {
        let (domains, excluded_domains) = parse_domains(&line[..idx]);
        let close = line.rfind(')')?;
        let open = idx + "#@#+js(".len();
        if close < open {
            return None;
        }
        let name = parse_scriptlet_args(&line[open..close]).into_iter().next()?;
        return Some(ParsedRule {
            rule_type: "scriptlet-exception".into(),
            domains,
            excluded_domains,
            selector: None,
            exception: Some(true),
            name: Some(name),
            args: None,
        });
    }
    if line.contains("##+js(") || line.contains("#+js(") {
        return parse_scriptlet(line);
    }
    if let Some(idx) = line.find("#@#") {
        let (domains, excluded_domains) = parse_domains(&line[..idx]);
        return Some(ParsedRule {
            rule_type: "cosmetic".into(),
            domains,
            excluded_domains,
            selector: Some(line[idx + 3..].into()),
            exception: Some(true),
            name: None,
            args: None,
        });
    }
    if let Some(idx) = line.find("#?#") {
        let (domains, excluded_domains) = parse_domains(&line[..idx]);
        return Some(ParsedRule {
            rule_type: "cosmetic".into(),
            domains,
            excluded_domains,
            selector: Some(line[idx + 3..].into()),
            exception: Some(false),
            name: None,
            args: None,
        });
    }
    if let Some(idx) = line.find("##") {
        let (domains, excluded_domains) = parse_domains(&line[..idx]);
        return Some(ParsedRule {
            rule_type: "cosmetic".into(),
            domains,
            excluded_domains,
            selector: Some(line[idx + 2..].into()),
            exception: Some(false),
            name: None,
            args: None,
        });
    }
    None
}

/// Split a comma-separated domain list into includes and `~` exclusions.
///
/// Mirrors `splitDomainList` in src/shared/filter-syntax.js; the two must agree
/// or a filter means one thing at build time and another at runtime.
fn parse_domains(domains: &str) -> (Vec<String>, Vec<String>) {
    let mut included = Vec::new();
    let mut excluded = Vec::new();

    for token in domains.split(',') {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        match token.strip_prefix('~') {
            Some(rest) => {
                let rest = rest.trim();
                if !rest.is_empty() {
                    excluded.push(rest.to_string());
                }
            }
            None => included.push(token.to_string()),
        }
    }

    (included, excluded)
}

fn parse_scriptlet(line: &str) -> Option<ParsedRule> {
    let (domains, open) = if let Some(idx) = line.find("##+js(") {
        (&line[..idx], idx + 6)
    } else {
        let idx = line.find("#+js(")?;
        (&line[..idx], idx + 5)
    };
    // Require a real closing paren after the opener. Blindly slicing off the
    // last byte panics on a missing ')' (start > end) or a trailing multi-byte
    // char (non-char-boundary) — both reachable from untrusted filter text.
    let close = line.rfind(')')?;
    if close < open {
        return None;
    }
    let rest = &line[open..close];
    let args = parse_scriptlet_args(rest);
    let mut args_iter = args.into_iter();
    let name = args_iter.next()?;
    let (domains, excluded_domains) = parse_domains(domains);
    Some(ParsedRule {
        rule_type: "scriptlet".into(),
        domains,
        excluded_domains,
        selector: None,
        exception: None,
        name: Some(name),
        args: Some(args_iter.collect()),
    })
}

/// Finalize one raw argument the way the JS parsers do: trim whitespace, then
/// strip at most ONE leading and ONE trailing quote character (of either
/// kind), mirroring `replace(/^['"]|['"]$/g, '')` in filter-parser.js and
/// build-rules.mjs. Interior quotes are preserved.
fn finalize_scriptlet_arg(raw: &str) -> String {
    let trimmed = raw.trim();
    let trimmed = trimmed.strip_prefix(['\'', '"']).unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix(['\'', '"']).unwrap_or(trimmed);
    trimmed.to_string()
}

/// Split a scriptlet argument list on commas, respecting quoted commas.
///
/// Must match the JS parsers (filter-parser.js / build-rules.mjs): quote
/// characters are kept in the argument text — `div[id='ad']` stays intact —
/// and only one surrounding quote pair is stripped per argument. The one
/// deliberate divergence is unpaired quotes: the JS parsers leave the quote
/// state open so every later comma stops splitting and arguments merge
/// (§5.17); here a quote only opens quoted mode when a matching close quote
/// exists later in the string, so `aopr, don't, x` still splits into three
/// arguments. Paired-quote inputs behave identically in all three engines.
fn parse_scriptlet_args(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for (idx, ch) in s.char_indices() {
        match ch {
            '\'' | '"' => {
                match quote {
                    Some(open) if open == ch => quote = None,
                    None if s[idx + ch.len_utf8()..].contains(ch) => quote = Some(ch),
                    _ => {}
                }
                current.push(ch);
            }
            ',' if quote.is_none() => {
                args.push(finalize_scriptlet_arg(&current));
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        args.push(finalize_scriptlet_arg(&current));
    }
    args
}

#[derive(Serialize, Deserialize)]
pub struct DnrRule {
    id: u32,
    priority: u16,
    action: DnrAction,
    condition: DnrCondition,
}
#[derive(Serialize, Deserialize)]
pub struct DnrAction {
    #[serde(rename = "type")]
    action_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    redirect: Option<DnrRedirect>,
}
#[derive(Serialize, Deserialize)]
pub struct DnrRedirect {
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct DnrCondition {
    #[serde(rename = "urlFilter", skip_serializing_if = "Option::is_none")]
    pub url_filter: Option<String>,
    #[serde(rename = "regexFilter", skip_serializing_if = "Option::is_none")]
    pub regex_filter: Option<String>,
    #[serde(rename = "resourceTypes", skip_serializing_if = "Option::is_none")]
    pub resource_types: Option<Vec<String>>,
    #[serde(
        rename = "excludedResourceTypes",
        skip_serializing_if = "Option::is_none"
    )]
    pub excluded_resource_types: Option<Vec<String>>,
    #[serde(rename = "domainType", skip_serializing_if = "Option::is_none")]
    pub domain_type: Option<String>,
    #[serde(rename = "initiatorDomains", skip_serializing_if = "Option::is_none")]
    pub initiator_domains: Option<Vec<String>>,
    #[serde(
        rename = "excludedInitiatorDomains",
        skip_serializing_if = "Option::is_none"
    )]
    pub excluded_initiator_domains: Option<Vec<String>>,
    #[serde(
        rename = "excludedRequestDomains",
        skip_serializing_if = "Option::is_none"
    )]
    pub excluded_request_domains: Option<Vec<String>>,
}

// Counts filter rules dropped by the critical-path guard in
// `parse_network_rule_to_dnr`. Previously these were discarded silently,
// which made filter-list breakage untraceable. JS reads this via
// `critical_path_drop_count()` so the diagnostic surfaces in the UI.
static CRITICAL_PATH_DROPS: AtomicU32 = AtomicU32::new(0);
// Counts rules dropped because they use a uBO option we can't translate
// to Chrome DNR (e.g. $csp, $rewrite). Also surfaced via getter.
static UNSUPPORTED_OPT_DROPS: AtomicU32 = AtomicU32::new(0);

#[wasm_bindgen]
pub fn critical_path_drop_count() -> u32 {
    CRITICAL_PATH_DROPS.load(Ordering::Relaxed)
}

#[wasm_bindgen]
pub fn reset_critical_path_drop_count() {
    CRITICAL_PATH_DROPS.store(0, Ordering::Relaxed);
}

#[wasm_bindgen]
pub fn unsupported_opt_drop_count() -> u32 {
    UNSUPPORTED_OPT_DROPS.load(Ordering::Relaxed)
}

#[wasm_bindgen]
pub fn reset_unsupported_opt_drop_count() {
    UNSUPPORTED_OPT_DROPS.store(0, Ordering::Relaxed);
}

fn parse_network_rule_to_dnr(line: &str, id: u32) -> Option<DnrRule> {
    let is_exception = line.starts_with("@@");
    let pattern_part = if is_exception { &line[2..] } else { line };

    let (pattern, options_str) = match pattern_part.find('$') {
        Some(idx) => (&pattern_part[..idx], Some(&pattern_part[idx + 1..])),
        None => (pattern_part, None),
    };

    if pattern.is_empty() || pattern == "*" || pattern == "||" {
        return None;
    }

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
                if opts.contains("important") {
                    is_important = true;
                }
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
        condition.regex_filter = Some(pattern[1..pattern.len() - 1].to_string());
    } else {
        condition.url_filter = Some(pattern.to_string());
    }

    if let Some(opts) = options_str {
        for opt in opts.split(',') {
            let opt_trimmed = opt.trim();
            let negated = opt_trimmed.starts_with('~');
            let opt_name = if negated {
                &opt_trimmed[1..]
            } else {
                opt_trimmed
            };

            // Options that take an argument (key=value).
            if let Some(eq_idx) = opt_name.find('=') {
                let (key, value) = (&opt_name[..eq_idx], &opt_name[eq_idx + 1..]);
                match key {
                    "domain" => {
                        // uBO: $domain=a.com|~b.com — pipe-delimited, '~' prefix excludes.
                        let mut included: Vec<String> = Vec::new();
                        let mut excluded: Vec<String> = Vec::new();
                        for entry in value.split('|') {
                            let e = entry.trim();
                            if e.is_empty() {
                                continue;
                            }
                            if let Some(stripped) = e.strip_prefix('~') {
                                excluded.push(stripped.to_lowercase());
                            } else {
                                included.push(e.to_lowercase());
                            }
                        }
                        if !included.is_empty() {
                            condition.initiator_domains = Some(included);
                        }
                        if !excluded.is_empty() {
                            condition.excluded_initiator_domains = Some(excluded);
                        }
                    }
                    "denyallow" => {
                        // Requests to these domains are allowed despite matching.
                        let doms: Vec<String> = value
                            .split('|')
                            .map(|s| s.trim().to_lowercase())
                            .filter(|s| !s.is_empty())
                            .collect();
                        if !doms.is_empty() {
                            condition.excluded_request_domains = Some(doms);
                        }
                    }
                    // Known but unmappable-to-DNR options. Count them so the
                    // coverage gap is auditable instead of invisible.
                    "csp" | "rewrite" | "removeparam" | "redirect" | "redirect-rule" => {
                        UNSUPPORTED_OPT_DROPS.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => { /* unknown arg option — ignore */ }
                }
                continue;
            }

            match opt_name {
                "important" => is_important = true,
                // Cosmetic-scope modifiers (§4.36). `@@||example.com^$generichide`
                // means "don't apply generic element hiding here". The user-filter
                // pipeline has no cosmetic-scope channel, and stripping the option
                // would degrade the line into a bare network allow — disabling ALL
                // blocking on the domain instead of only element hiding. Drop the
                // rule and count it; never emit a network allow.
                "elemhide" | "ehide" | "generichide" | "ghide" | "specifichide" | "shide" => {
                    UNSUPPORTED_OPT_DROPS.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
                "badfilter" => {
                    // uBO: $badfilter invalidates a matching non-badfilter rule
                    // elsewhere. We don't model cross-rule invalidation, so
                    // the safest action is to drop this rule entirely rather
                    // than emit it as a live block.
                    return None;
                }
                "popup" => {
                    let mut types = condition.resource_types.unwrap_or_default();
                    if !types.iter().any(|t| t == "main_frame") {
                        types.push("main_frame".to_string());
                    }
                    condition.resource_types = Some(types);
                }
                "script" | "image" | "stylesheet" | "xmlhttprequest" | "subdocument"
                | "document" | "media" | "font" | "websocket" | "ping" | "other" => {
                    let dnr_type = match opt_name {
                        "subdocument" => "sub_frame",
                        "document" => "main_frame",
                        _ => opt_name,
                    }
                    .to_string();

                    if negated {
                        let mut types = condition.excluded_resource_types.unwrap_or_default();
                        types.push(dnr_type);
                        condition.excluded_resource_types = Some(types);
                    } else {
                        let mut types = condition.resource_types.unwrap_or_default();
                        types.push(dnr_type);
                        condition.resource_types = Some(types);
                    }
                }
                "third-party" | "3p" => {
                    condition.domain_type =
                        Some(if negated { "firstParty" } else { "thirdParty" }.to_string());
                }
                "first-party" | "1p" => {
                    condition.domain_type =
                        Some(if negated { "thirdParty" } else { "firstParty" }.to_string());
                }
                _ => {}
            }
        }
    }

    // uBO ordering: a plain exception beats a plain block, but an $important
    // block beats that exception — overriding exceptions is the whole purpose
    // of $important, and the anti-circumvention lists depend on it. The old
    // scheme put every exception (10) above every important block (5), so the
    // modifier was inert. Matches DNR_PRIORITY in scripts/build-rules.mjs;
    // runtime rules still sit far above at 500 (allowlist) and 1000
    // (system-unbreak).
    let priority = match (is_exception, is_important) {
        (true, true) => 4u16,   // @@...$important
        (true, false) => 2u16,  // @@...
        (false, true) => 3u16,  // ...$important
        (false, false) => 1u16, // plain block
    };

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
pub struct KeywordMatcher {
    ac: AhoCorasick,
}

#[wasm_bindgen]
impl KeywordMatcher {
    #[wasm_bindgen(constructor)]
    pub fn new(patterns_csv: &str) -> Self {
        let patterns: Vec<&str> = patterns_csv
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        // Matches `UrlSanitizer::new` — fall back to an empty automaton on
        // AhoCorasick construction failure rather than panicking across the
        // JS boundary.
        let ac = AhoCorasick::new(&patterns)
            .unwrap_or_else(|_| AhoCorasick::new::<[&str; 0], &str>([]).unwrap());
        Self { ac }
    }
    pub fn matches(&self, text: &str) -> bool {
        self.ac.is_match(text)
    }
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
        let domains = csv
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        Self { domains }
    }

    /// Returns true if `hostname` or any of its parent domains (up to but
    /// excluding the first public suffix) is in the allowlist. Without the
    /// public-suffix guard a rule at e.g. `co.uk` would match every site on
    /// that TLD. Exact membership is honoured before the suffix stop: a
    /// curated public suffix (`netlify.app`) can itself be a browsable site
    /// the user deliberately allowlisted, and must match its own entry —
    /// mirrors `allowlistCoversHostname` on the JS side (§4.8).
    pub fn check(&self, hostname: &str) -> bool {
        let lower = hostname.to_lowercase();
        if self.domains.contains(lower.as_str()) {
            return true;
        }
        let mut h: &str = &lower;
        if is_public_suffix(h) {
            return false;
        }
        loop {
            match h.find('.') {
                Some(idx) => h = &h[idx + 1..],
                None => return false,
            }
            if is_public_suffix(h) {
                return false;
            }
            if self.domains.contains(h) {
                return true;
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

    pub fn size(&self) -> usize {
        self.domains.len()
    }
}

// ---------------------------------------------------------------------------
// UrlSanitizer — stateful, tracking-param set built once for query stripping
// ---------------------------------------------------------------------------

/// Pre-compiles tracking parameter names into a set once. Call
/// `.sanitize(url)` on every request instead of re-parsing the list.
///
/// Keys are matched *exactly*: substring matching stripped `referral_code`
/// because `ref` was on the list (§5.23). The URL fragment is preserved —
/// it was previously folded into the last query pair and dropped.
#[wasm_bindgen]
pub struct UrlSanitizer {
    params: HashSet<String>,
}

#[wasm_bindgen]
impl UrlSanitizer {
    #[wasm_bindgen(constructor)]
    pub fn new(patterns_csv: &str) -> Self {
        let params = patterns_csv
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Self { params }
    }

    pub fn sanitize(&self, url: &str) -> String {
        // Split the fragment off first: it is not part of the query and must
        // survive sanitization verbatim.
        let (without_fragment, fragment) = match url.split_once('#') {
            Some((head, frag)) => (head, Some(frag)),
            None => (url, None),
        };
        let Some((base, query)) = without_fragment.split_once('?') else {
            return url.to_string();
        };
        let clean: Vec<&str> = query
            .split('&')
            .filter(|pair| {
                let key = pair.split('=').next().unwrap_or("");
                !self.params.contains(key)
            })
            .collect();
        let mut out = if clean.is_empty() {
            base.to_string()
        } else {
            format!("{}?{}", base, clean.join("&"))
        };
        if let Some(frag) = fragment {
            out.push('#');
            out.push_str(frag);
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Procedural Selector Planning
// ---------------------------------------------------------------------------

/// All uBO/ABP procedural operators, longest-first to prevent partial prefix matches.
fn proc_op_ac() -> &'static AhoCorasick {
    static AC: OnceLock<AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| {
        AhoCorasick::new([
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
        ])
        .unwrap()
    })
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

/// Version of the procedural-plan JSON format (§5.21), written into every
/// planned bundle and every serialized rule so future consumers can detect a
/// format change instead of misreading stored payloads. Payloads written
/// before versioning carry no field and deserialize as version 1 — the format
/// itself is unchanged, so legacy bundles remain fully compatible.
const PLAN_FORMAT_VERSION: u32 = 1;

fn plan_format_version() -> u32 {
    PLAN_FORMAT_VERSION
}

#[derive(Serialize, Deserialize, Clone)]
struct PlannedSelectorRule {
    selector: String,
    plan: Vec<ProceduralPlanStep>,
    #[serde(rename = "planVersion", default = "plan_format_version")]
    plan_version: u32,
}

#[derive(Serialize, Deserialize)]
struct PlannedSelectorBundle {
    #[serde(default = "plan_format_version")]
    version: u32,
    #[serde(rename = "cssSelectors")]
    css_selectors: Vec<String>,
    #[serde(rename = "proceduralRules")]
    procedural_rules: Vec<PlannedSelectorRule>,
}

impl Default for PlannedSelectorBundle {
    fn default() -> Self {
        Self {
            version: PLAN_FORMAT_VERSION,
            css_selectors: Vec::new(),
            procedural_rules: Vec::new(),
        }
    }
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
    if trimmed.is_empty() || trimmed.contains('{') || trimmed.contains('}') {
        return false;
    }
    // NUL would desync the NUL-terminated binary rule framing in
    // `serialize_rules_to_binary_lists`, shifting every subsequent entry
    // (§5.19). No real selector contains one; reject at ingestion.
    if trimmed.contains('\0') {
        return false;
    }
    // `;` is CSS-injection material everywhere except inside a `:style(...)`
    // argument, where uBO rules legitimately carry multiple declarations
    // (§4.35). Rejecting those at ingestion kept them from ever reaching the
    // implemented `style` operator.
    !trimmed.contains(';') || semicolons_confined_to_style_args(trimmed)
}

/// True when every `;` in `selector` sits inside the argument of a
/// `:style(...)` operator (paren-aware, so nested parens in the argument are
/// handled). Any `;` outside such an argument stays rejected.
fn semicolons_confined_to_style_args(selector: &str) -> bool {
    const STYLE_OP: &str = ":style(";
    let mut idx = 0;
    while idx < selector.len() {
        let Some(rel) = selector[idx..].find(STYLE_OP) else {
            return !selector[idx..].contains(';');
        };
        if selector[idx..idx + rel].contains(';') {
            return false;
        }
        let arg_start = idx + rel + STYLE_OP.len();
        match find_matching_paren(selector, arg_start) {
            Some(close) => idx = close + 1,
            // Unbalanced `:style(` — malformed; a stray `;` past this point
            // has no closed argument to live in.
            None => return false,
        }
    }
    true
}

fn has_balanced_selector_delimiters(selector: &str) -> bool {
    let mut bracket_depth = 0usize;
    let mut paren_depth = 0usize;
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
            '[' => {
                // Nested attribute selectors are not valid CSS unless the
                // inner bracket is quoted, in which case it is skipped above.
                if bracket_depth > 0 {
                    return false;
                }
                bracket_depth += 1;
            }
            ']' => {
                if bracket_depth == 0 {
                    return false;
                }
                bracket_depth -= 1;
            }
            '(' => paren_depth += 1,
            ')' => {
                if paren_depth == 0 {
                    return false;
                }
                paren_depth -= 1;
            }
            '{' | '}' => return false,
            _ => {}
        }
    }

    // All delimiters must be balanced and no unclosed quotes
    quoted.is_none() && bracket_depth == 0 && paren_depth == 0
}

fn has_invalid_universal_usage(selector: &str) -> bool {
    // Byte-index walk over the original &str: no per-selector Vec<char> and no
    // per-`::` tail String — this runs across ~45k selectors on every index
    // rebuild (§5.22).
    let mut bracket_depth = 0i32;
    let mut paren_depth = 0i32;
    let mut quoted: Option<char> = None;
    let mut escaped = false;
    // The character immediately preceding the current one, unfiltered.
    // Whitespace before `*` is a descendant combinator (`div *` is valid);
    // only a directly glued identifier char (`div*`) is the bypass shape.
    let mut prev: Option<char> = None;

    for (idx, ch) in selector.char_indices() {
        let prev_char = prev;
        prev = Some(ch);

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
                    return true;
                }
            }
            '(' => paren_depth += 1,
            ')' => {
                paren_depth -= 1;
                if paren_depth < 0 {
                    return true;
                }
            }
            '*' if bracket_depth == 0 && paren_depth == 0 => {
                // Universal selector (*) is invalid when glued to an
                // identifier or a closing bracket/paren: `div*`, `.class*`,
                // `[a]*`. Inspect the *immediate* predecessor — skipping
                // whitespace here conflated `div *` (valid descendant
                // combinator) with `div*` (invalid) and silently dropped
                // shipped selectors (§4.35).
                if prev_char.is_some_and(|c| {
                    c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ')' || c == ']'
                }) {
                    return true;
                }
                // After `*` allow: element/ident, #, ., [, pseudo (:), a
                // combinator (>, +, ~, whitespace), a selector-list comma,
                // or end of input. Anything else is a malformed-selector
                // bypass shape.
                let next = selector[idx + 1..].chars().find(|c| !c.is_whitespace());
                if let Some(n) = next {
                    if !n.is_ascii_alphanumeric()
                        && n != '#'
                        && n != '.'
                        && n != '['
                        && n != ':'
                        && n != '>'
                        && n != '+'
                        && n != '~'
                        && n != ','
                    {
                        return true;
                    }
                }
            }
            // Pseudo-element safety: reject double-colon followed by an
            // unknown pseudo-element. `starts_with` on the original slice —
            // no allocation.
            ':' if selector[idx + 1..].starts_with(':') => {
                const KNOWN_PSEUDO_ELEMENTS: [&str; 12] = [
                    "::before",
                    "::after",
                    "::first-line",
                    "::first-letter",
                    "::selection",
                    "::backdrop",
                    "::placeholder",
                    "::marker",
                    "::cue",
                    "::slotted",
                    "::part",
                    "::file-selector-button",
                ];
                let rest = &selector[idx..];
                if !KNOWN_PSEUDO_ELEMENTS.iter().any(|p| rest.starts_with(p)) {
                    // Unknown pseudo-element — could be bypass attempt
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

// Chunk the exception CSS the same way we chunk block CSS. One monolithic
// selector-list rule has two failure modes: (1) any unbalanced token
// invalidates the entire declaration (browsers fail-open, so excepted
// elements stay hidden), and (2) tens of thousands of selectors stress
// the parser. Chunking contains the blast radius and matches the safety
// profile of `build_css_from_selector_list`.
fn build_exception_css(exceptions: &[String], chunk_size: usize) -> String {
    if exceptions.is_empty() {
        return String::new();
    }
    let cap = if chunk_size == 0 { 100 } else { chunk_size };
    let mut out = Vec::with_capacity(exceptions.len() / cap + 1);
    for chunk in exceptions.chunks(cap) {
        out.push(format!(
            "{} {{ display: revert !important; visibility: revert !important; }}",
            chunk.join(",")
        ));
    }
    out.join("\n")
}

fn serialize_rules_to_binary_lists(
    generic: &[String],
    domain_specific: &[String],
    exceptions: &[String],
) -> Vec<u8> {
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
    // Two views of the exception list (§5.18):
    // - `exceptions`: CSS-safe selectors only — these become the `revert` CSS
    //   and travel to the content script.
    // - `suppression_set`: every valid exception selector, *including
    //   procedural ones*. A `#@#` exception for `div:has-text(Ad)` is not CSS
    //   and cannot be reverted by a stylesheet, but it must still cancel the
    //   matching procedural rule below. Filtering it through
    //   `is_css_safe_selector` first discarded it before the suppression
    //   check ever ran.
    let mut exceptions = Vec::new();
    let mut exception_seen = HashSet::new();
    let mut suppression_set: HashSet<String> = HashSet::new();
    for selector in exceptions_in {
        let selector = selector.trim();
        if !is_valid_selector(selector) {
            continue;
        }
        suppression_set.insert(selector.to_string());
        if !is_css_safe_selector(selector) {
            continue;
        }
        if exception_seen.insert(selector.to_string()) {
            exceptions.push(selector.to_string());
        }
    }

    let mut css_selectors = Vec::new();
    let mut procedural_rules = Vec::new();

    for selector in generic_in.into_iter().chain(domain_specific_in) {
        let selector = selector.trim();
        if !is_valid_selector(selector) || suppression_set.contains(selector) {
            continue;
        }

        if contains_proc_op(selector) {
            procedural_rules.push(PlannedSelectorRule {
                selector: selector.to_string(),
                plan: parse_procedural_plan(selector),
                plan_version: PLAN_FORMAT_VERSION,
            });
        } else if is_css_safe_selector(selector) {
            css_selectors.push(selector.to_string());
        }
    }

    let css_text = build_css_from_selector_list(&css_selectors, css_chunk_size);
    let exception_css = build_exception_css(&exceptions, css_chunk_size);

    let binary_domain_specific: Vec<String> = procedural_rules
        .iter()
        .filter_map(|rule| serde_json::to_string(rule).ok())
        .collect();

    let cosmetic_rules_binary =
        serialize_rules_to_binary_lists(&Vec::new(), &binary_domain_specific, &exceptions);

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
                plan_version: PLAN_FORMAT_VERSION,
            });
        } else if is_css_safe_selector(selector) {
            bundle.css_selectors.push(selector.to_string());
        }
    }

    serde_json::to_string(&bundle).unwrap_or_else(|_| {
        "{\"version\":1,\"cssSelectors\":[],\"proceduralRules\":[]}".to_string()
    })
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
) -> Result<JsValue, JsValue> {
    let generic_in: Vec<String> = from_js_value(generic)?;
    let domain_specific_in: Vec<String> = from_js_value(domain_specific)?;
    let exceptions_in: Vec<String> = from_js_value(exceptions)?;
    let bundle = build_page_bundle_internal(
        generic_in,
        domain_specific_in,
        exceptions_in,
        css_chunk_size,
    );

    let bundle_obj = Object::new();
    let rules_obj = Object::new();

    let generic_js = Array::new();
    let domain_specific_js = serde_wasm_bindgen::to_value(&bundle.rules.domain_specific)
        .unwrap_or_else(|_| Array::new().into());
    let exceptions_js = serde_wasm_bindgen::to_value(&bundle.rules.exceptions)
        .unwrap_or_else(|_| Array::new().into());
    let binary_js = Uint8Array::from(bundle.cosmetic_rules_binary.as_slice());

    let _ = Reflect::set(
        &rules_obj,
        &JsValue::from_str("generic"),
        &generic_js.into(),
    );
    let _ = Reflect::set(
        &rules_obj,
        &JsValue::from_str("domainSpecific"),
        &domain_specific_js,
    );
    let _ = Reflect::set(&rules_obj, &JsValue::from_str("exceptions"), &exceptions_js);

    let _ = Reflect::set(&bundle_obj, &JsValue::from_str("rules"), &rules_obj.into());
    let _ = Reflect::set(
        &bundle_obj,
        &JsValue::from_str("cssText"),
        &JsValue::from_str(&bundle.css_text),
    );
    let _ = Reflect::set(
        &bundle_obj,
        &JsValue::from_str("exceptionCss"),
        &JsValue::from_str(&bundle.exception_css),
    );
    let _ = Reflect::set(
        &bundle_obj,
        &JsValue::from_str("cosmeticRulesBinary"),
        &binary_js.into(),
    );

    Ok(bundle_obj.into())
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
    let exc: HashSet<&str> = exceptions
        .split('\n')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    let cap = if chunk_size == 0 { 100 } else { chunk_size };

    let mut seen: HashSet<&str> = HashSet::new();
    let unique: Vec<&str> = selectors
        .split('\n')
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

/// Total selector/scriptlet entries a source contributes, for the §5.20 cap.
fn filter_source_entry_count(source: &FilterSourceBundle) -> usize {
    source.cosmetic.generic.len()
        + source
            .cosmetic
            .domain_specific
            .values()
            .map(Vec::len)
            .sum::<usize>()
        + source
            .cosmetic
            .exceptions
            .values()
            .map(Vec::len)
            .sum::<usize>()
        + source.scriptlets.len()
}

fn compile_active_filter_index_internal(
    core_source: FilterSourceBundle,
    list_sources: Vec<FilterSourceBundle>,
    css_chunk_size: usize,
) -> Result<ActiveFilterIndex, String> {
    let total_entries = filter_source_entry_count(&core_source)
        + list_sources
            .iter()
            .map(filter_source_entry_count)
            .sum::<usize>();
    check_input_size(
        "compile_active_filter_index",
        "entries",
        total_entries,
        MAX_INDEX_INPUT_ENTRIES,
    )?;

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

    let cosmetic =
        reduce_cosmetic_rules_internal(merged_generic, merged_domains, merged_exceptions);

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

    if (!cosmetic.generic.is_empty()
        || merged_scriptlets.iter().any(|rule| rule.domains.is_empty()))
        && bloom_seen.insert(String::new())
    {
        bloom_hosts.push(String::new());
    }

    let generic_css = build_page_bundle_internal(
        cosmetic.generic.clone(),
        Vec::new(),
        Vec::new(),
        css_chunk_size,
    )
    .css_text;

    Ok(ActiveFilterIndex {
        cosmetic,
        scriptlets: merged_scriptlets,
        generic_css,
        bloom_hosts,
    })
}

#[wasm_bindgen]
pub fn compile_active_filter_index(
    core_source: JsValue,
    list_sources: JsValue,
    css_chunk_size: usize,
) -> Result<JsValue, JsValue> {
    let core_source: FilterSourceBundle = from_js_value(core_source)?;
    let list_sources: Vec<FilterSourceBundle> = from_js_value(list_sources)?;
    let index = compile_active_filter_index_internal(core_source, list_sources, css_chunk_size)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(to_js_value(&index))
}

// ---------------------------------------------------------------------------
// CSS Selector Sanitizer & Compactor
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn sanitize_and_compact_selectors(csv: &str, chunk_size: usize) -> String {
    let selectors: Vec<String> = csv
        .split('\n')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    build_css_from_selector_list(&selectors, chunk_size)
}

// ---------------------------------------------------------------------------
// Binary Rule Transfer
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn serialize_rules_to_binary_from_json(
    generic_json: &str,
    domain_specific_json: &str,
    exceptions_json: &str,
) -> Vec<u8> {
    let generic: Vec<String> = serde_json::from_str(generic_json).unwrap_or_default();
    let domain_specific: Vec<String> =
        serde_json::from_str(domain_specific_json).unwrap_or_default();
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
            "google.com"
            | "doubleclick.net"
            | "googlesyndication.com"
            | "google-analytics.com"
            | "gstatic.com"
            | "googleadservices.com"
            | "2mdn.net" => "Google",
            "facebook.com" | "facebook.net" | "fbcdn.net" | "fbsbx.com" | "fbevents.com"
            | "messenger.com" | "instagram.com" => "Meta",
            "amazon-adsystem.com" | "media-amazon.com" | "assoc-amazon.com" => "Amazon",
            "bing.com" | "msn.com" | "live.com" | "ads.microsoft.com" | "clarity.ms"
            | "azureedge.net" => "Microsoft",
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
pub fn process_youtube_player(text: &str) -> Result<String, JsValue> {
    process_youtube_player_checked(text).map_err(|e| JsValue::from_str(&e))
}

// §5.20: an oversized payload is refused with a structured error; the
// caller's try/catch falls back to using the original response text.
fn process_youtube_player_checked(text: &str) -> Result<String, String> {
    check_input_size(
        "process_youtube_player",
        "bytes",
        text.len(),
        MAX_YT_PLAYER_BYTES,
    )?;
    Ok(process_youtube_player_internal(text))
}

fn process_youtube_player_internal(text: &str) -> String {
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

    // §4.8 related: a curated public suffix (netlify.app, github.io) can be a
    // browsable site in its own right. Exact allowlist membership must match
    // before the public-suffix stop, while ancestor walks still refuse to
    // blanket a TLD from a `co.uk`-style entry. Mirrors the JS
    // `allowlistCoversHostname` semantics.
    #[test]
    fn allowlist_matcher_honours_exact_membership_at_a_public_suffix() {
        let m = AllowlistMatcher::new("netlify.app,example.com");
        assert!(m.check("netlify.app")); // exact hit at a curated suffix
        assert!(m.check("sub.example.com")); // ancestor walk still works
        assert!(!m.check("someuser.netlify.app")); // suffix stops the walk
        let tld = AllowlistMatcher::new("co.uk");
        assert!(tld.check("co.uk")); // exact only
        assert!(!tld.check("bbc.co.uk")); // never blankets the TLD
    }

    #[test]
    fn bloom_deserialize_rejects_corrupt_payloads_without_panicking() {
        // size == 0 would divide-by-zero in has(); short data would index OOB.
        let div0 = BloomFilter::deserialize_from_json("{\"size\":0,\"hashes\":1,\"data\":[]}");
        assert!(!div0.has("anything")); // safe empty fallback, no panic
        let short = BloomFilter::deserialize_from_json("{\"size\":1024,\"hashes\":4,\"data\":[1]}");
        assert!(!short.has("anything"));
        let garbage = BloomFilter::deserialize_from_json("not json");
        assert!(!garbage.has("anything"));
    }

    /// Selectors recorded for a domain in a bundle map, for readable asserts.
    fn selectors_for<'a>(
        map: &'a HashMap<String, Vec<String>>,
        domain: &str,
    ) -> Option<&'a Vec<String>> {
        map.get(domain)
    }

    // A `~`-prefixed entry is an exclusion. Keeping it as a literal positive
    // domain inverts the meaning twice over: the rule is stored under a key
    // that matches no hostname, while the ancestor walk still reaches the
    // subdomain the author was protecting. The JS parsers were fixed already;
    // this is the same defect in the Rust engine.
    #[test]
    fn parse_domains_splits_exclusions_from_includes() {
        let bundle = parse_filter_source_internal("example.com,~mail.example.com##.promo");

        assert_eq!(
            selectors_for(&bundle.cosmetic.domain_specific, "example.com"),
            Some(&vec![".promo".to_string()]),
            "must apply on the included domain",
        );
        assert_eq!(
            selectors_for(&bundle.cosmetic.exceptions, "mail.example.com"),
            Some(&vec![".promo".to_string()]),
            "and be excepted on the excluded subdomain",
        );
        assert!(
            !bundle.cosmetic.domain_specific.contains_key("~mail.example.com"),
            "the ~ form must never become a positive domain key",
        );
    }

    #[test]
    fn pure_negation_cosmetic_is_generic_with_an_exception() {
        // "everywhere except example.com" — previously keyed under the literal
        // "~example.com", which equals no hostname, so it applied nowhere.
        let bundle = parse_filter_source_internal("~example.com##.ad");

        assert_eq!(bundle.cosmetic.generic, vec![".ad".to_string()]);
        assert_eq!(
            selectors_for(&bundle.cosmetic.exceptions, "example.com"),
            Some(&vec![".ad".to_string()]),
        );
    }

    #[test]
    fn scriptlet_exclusions_are_carried_not_flattened() {
        let bundle =
            parse_filter_source_internal("youtube.com,~music.youtube.com##+js(set, yt.ads, false)");

        assert_eq!(bundle.scriptlets.len(), 1);
        assert_eq!(bundle.scriptlets[0].domains, vec!["youtube.com".to_string()]);
        assert_eq!(
            bundle.scriptlets[0].excluded_domains,
            vec!["music.youtube.com".to_string()],
        );
    }

    // `#@#+js(name)` disables a scriptlet on a site. `line.contains("#+js(")`
    // matches the substring inside `#@#+js(`, so the line was routed to
    // parse_scriptlet and produced an *active* scriptlet whose domain was the
    // garbage prefix "example.com#@".
    #[test]
    fn scriptlet_exception_is_not_parsed_as_an_active_scriptlet() {
        let bundle = parse_filter_source_internal("example.com#@#+js(nowebrtc)");

        assert!(
            bundle.scriptlets.is_empty(),
            "an exception must not create a scriptlet, got {:?}",
            bundle.scriptlets,
        );
        assert!(
            !bundle.cosmetic.domain_specific.contains_key("example.com#@"),
            "and must not leave a garbage domain key",
        );
    }

    #[test]
    fn scriptlet_exception_excludes_the_named_scriptlet() {
        let bundle = parse_filter_source_internal(
            "##+js(nowebrtc)\n##+js(aopr, x)\nexample.com#@#+js(nowebrtc)",
        );

        let nowebrtc = bundle
            .scriptlets
            .iter()
            .find(|s| s.name.as_deref() == Some("nowebrtc"))
            .expect("the scriptlet must survive for other sites");
        assert_eq!(nowebrtc.excluded_domains, vec!["example.com".to_string()]);

        let aopr = bundle
            .scriptlets
            .iter()
            .find(|s| s.name.as_deref() == Some("aopr"))
            .expect("an unrelated scriptlet must be untouched");
        assert!(aopr.excluded_domains.is_empty());
    }

    #[test]
    fn domainless_scriptlet_exception_drops_the_scriptlet() {
        let bundle =
            parse_filter_source_internal("##+js(nowebrtc)\n##+js(aopr, x)\n#@#+js(nowebrtc)");

        assert!(bundle
            .scriptlets
            .iter()
            .all(|s| s.name.as_deref() != Some("nowebrtc")));
        assert!(bundle
            .scriptlets
            .iter()
            .any(|s| s.name.as_deref() == Some("aopr")));
    }

    #[test]
    fn plain_cosmetic_rules_are_unaffected_by_exclusion_handling() {
        let bundle = parse_filter_source_internal("example.com##.ad\n##.generic-ad");

        assert_eq!(
            selectors_for(&bundle.cosmetic.domain_specific, "example.com"),
            Some(&vec![".ad".to_string()]),
        );
        assert_eq!(bundle.cosmetic.generic, vec![".generic-ad".to_string()]);
        assert!(bundle.cosmetic.exceptions.is_empty(), "no spurious exceptions");
    }

    #[test]
    fn important_blocks_outrank_plain_exceptions() {
        // Overriding an exception is the entire purpose of $important. With
        // exception 10 > important 5, the exception always won and the
        // modifier did nothing — badware.txt shipping an $important block to
        // defeat a stock exception had no effect.
        let priority_of = |filter: &str| {
            let compiled = compile_user_filters_internal(filter, 1);
            compiled
                .dnr_rules
                .first()
                .map(|r| r.priority)
                .unwrap_or_else(|| panic!("no rule emitted for {filter}"))
        };

        let plain_block = priority_of("||ads.example.com^");
        let plain_allow = priority_of("@@||ads.example.com^");
        let important_block = priority_of("||ads.example.com^$important");
        let important_allow = priority_of("@@||ads.example.com^$important");

        assert!(plain_allow > plain_block, "allow beats block");
        assert!(important_block > plain_allow, "important block beats allow");
        assert!(
            important_allow > important_block,
            "important allow beats important block",
        );
    }

    #[test]
    fn bloom_size_is_bounded_rather_than_allocated() {
        // An absurd declared size must be clamped, not honoured. Unclamped,
        // `new(u32::MAX, 4)` allocates a 134M-element Vec — half a gigabyte —
        // inside a service worker with a small heap.
        let filter = BloomFilter::new(u32::MAX as usize, 4);
        assert!(
            filter.bitset.len() <= MAX_BLOOM_BITS.div_ceil(32),
            "bitset must be bounded, got {} words",
            filter.bitset.len(),
        );

        // Clamping must stay self-consistent: whatever size survives, every
        // bit index it produces has to be in range.
        let mut bounded = BloomFilter::new(u32::MAX as usize, 4);
        bounded.add("example.com");
        assert!(bounded.has("example.com"));
    }

    #[test]
    fn bloom_rejects_a_size_beyond_the_cap() {
        // The wasm32 hazard: `usize` is 32-bit there and release builds wrap,
        // so `(size + 31) / 32` folded u32::MAX to 0 and a payload with an
        // empty `data` satisfied the length check — then `has()` indexed an
        // empty Vec. A 64-bit host cannot reproduce the wrap, so guard the
        // invariant that actually holds on both: a declared size past the cap
        // is refused outright, whatever `data` claims.
        let huge = format!("{{\"size\":{},\"hashes\":1,\"data\":[]}}", u32::MAX);
        let filter = BloomFilter::deserialize_from_json(&huge);
        assert!(!filter.has("anything"));
        assert!(
            filter.bitset.len() <= MAX_BLOOM_BITS.div_ceil(32),
            "an over-cap payload must degrade to the safe fallback",
        );
    }

    #[test]
    fn bloom_word_count_is_computed_without_overflow() {
        // Pins the reasoning that made the wasm32 bug possible, in u32 terms
        // so it holds regardless of host pointer width.
        assert_eq!(u32::MAX.wrapping_add(31) / 32, 0, "the old expression wraps to zero");
        assert!(u32::MAX.div_ceil(32) > 0, "div_ceil cannot overflow");
        for bits in [1u32, 31, 32, 33, 1024] {
            assert_eq!(bits.div_ceil(32), (bits as u64).div_ceil(32) as u32);
        }
    }

    #[test]
    fn bloom_bitset_is_long_enough_for_the_declared_size() {
        // Whatever clamping happens, every bit index has to be in range.
        for size in [1usize, 31, 32, 33, 1024, 65_535] {
            let mut filter = BloomFilter::new(size, 4);
            filter.add("example.com");
            assert!(filter.has("example.com"), "size {size} must round-trip");
        }
    }

    #[test]
    fn bloom_round_trips_valid_payload() {
        let mut b = BloomFilter::new(1024, 4);
        b.add("example.com");
        let restored = BloomFilter::deserialize_from_json(&b.serialize_to_json().unwrap());
        assert!(restored.has("example.com"));
    }

    #[test]
    fn bloom_constructor_clamps_zero_to_safe_minimum() {
        let mut b = BloomFilter::new(0, 0);
        b.add("x"); // must not divide-by-zero
        assert!(b.has("x"));
    }

    #[test]
    fn parse_scriptlet_handles_malformed_input_without_panicking() {
        assert!(parse_scriptlet("example.com##+js(").is_none()); // no closing paren
        assert!(parse_scriptlet("example.com##+js(set-constant").is_none());
        // trailing multi-byte char where the old `len()-1` slice was non-boundary
        assert!(parse_scriptlet("example.com##+js(é").is_none());
        let ok = parse_scriptlet("example.com##+js(set-constant, x, false)").unwrap();
        assert_eq!(ok.name.as_deref(), Some("set-constant"));
    }

    #[test]
    fn process_youtube_player_keeps_keys_but_neutralizes_values() {
        let input = concat!(
            "{\"adPlacements\":[{\"slot\":1}],",
            "\"playerAds\":{\"ad\":\"yes\"},",
            "\"web_disable_midroll_ads\":false,",
            "\"web_enable_ad_break_heartbeat\":true}"
        );

        let output = process_youtube_player_internal(input);

        assert!(output.contains("\"adPlacements\":false,\"disabled_adPlacements\":["));
        assert!(output.contains("\"playerAds\":false,\"disabled_playerAds\":{"));
        assert!(output.contains("\"web_disable_midroll_ads\":true"));
        assert!(output.contains("\"web_enable_ad_break_heartbeat\":false"));
    }

    #[test]
    fn process_youtube_player_skips_clean_payloads() {
        assert_eq!(process_youtube_player_internal("{\"streamingData\":{}}"), "");
    }

    #[test]
    fn plan_selector_rules_separates_css_and_procedural() {
        let planned =
            plan_selector_rules_json("[\".ad-slot\",\"div:has-text(Sponsored):upward(article)\"]");
        let parsed: serde_json::Value = serde_json::from_str(&planned).unwrap();

        assert_eq!(parsed["cssSelectors"][0], ".ad-slot");
        assert_eq!(
            parsed["proceduralRules"][0]["selector"],
            "div:has-text(Sponsored):upward(article)"
        );
        assert_eq!(parsed["proceduralRules"][0]["plan"][0]["type"], "css");
        assert_eq!(parsed["proceduralRules"][0]["plan"][1]["type"], "op");
    }

    #[test]
    fn reduce_cosmetic_rules_folds_exceptions_and_drops_generic_duplicates() {
        let reduced = reduce_cosmetic_rules_internal(
            vec![".global-ad".into(), ".global-ad".into(), ".hero-ad".into()],
            HashMap::from([(
                "example.com".to_string(),
                vec![
                    ".hero-ad".to_string(),
                    ".sidebar-ad".to_string(),
                    ".sidebar-ad".to_string(),
                ],
            )]),
            HashMap::from([("example.com".to_string(), vec![".allow-me".to_string()])]),
        );

        assert_eq!(reduced.generic.len(), 2);
        assert_eq!(reduced.domain_specific["example.com"][0], ".sidebar-ad");
        assert_eq!(
            reduced.domain_specific["example.com"][1],
            "__exception__.allow-me"
        );
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
        assert_eq!(
            bundle.rules.domain_specific[0].selector,
            "div:has-text(Sponsored):upward(article)"
        );
        assert_eq!(bundle.rules.exceptions, vec![".allow-me".to_string()]);
        assert!(bundle.exception_css.contains(".allow-me"));
        assert!(bundle.cosmetic_rules_binary.len() > 12);
    }

    #[test]
    fn selector_delimiter_balance_handles_quotes_and_nested_pseudos() {
        assert!(has_balanced_selector_delimiters(
            r#"a[href^="http://li.blogtrottr.com/click?"]"#
        ));
        assert!(has_balanced_selector_delimiters(r#"div:has(a[href*=")"])"#));
        assert!(has_balanced_selector_delimiters(r#":lang("en)")"#));
        assert!(has_balanced_selector_delimiters(
            r#":nth-child(2n+1 of :not([hidden]))"#
        ));

        assert!(!has_balanced_selector_delimiters(r#"div[role="main""#));
        assert!(!has_balanced_selector_delimiters(
            r#"div[attr="unterminated]"#
        ));
        assert!(!has_balanced_selector_delimiters("div:has(.ad"));
        assert!(!has_balanced_selector_delimiters("div]"));
        assert!(!has_balanced_selector_delimiters("div)"));
        assert!(!has_balanced_selector_delimiters("div[[data-ad]]"));
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
        assert_eq!(
            compiled.cosmetic_rules.generic,
            vec![".global-ad".to_string()]
        );
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
                excluded_domains: Vec::new(),
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
            vec![
                ".hero-ad".to_string(),
                ".sidebar-ad".to_string(),
                "__exception__.sidebar-ad".to_string()
            ]
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
            vec![
                " Example.com ".into(),
                "example.com".into(),
                "news.example.com".into(),
            ],
            990000,
        );

        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].id, 990000);
        assert_eq!(rules[0].priority, 500);
        assert_eq!(
            rules[0].condition.url_filter.as_deref(),
            Some("||example.com^")
        );
        assert_eq!(
            rules[1].condition.url_filter.as_deref(),
            Some("||news.example.com^")
        );
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
        )
        .expect("under the input cap");

        assert!(compiled.generic_css.contains(".ad"));
        assert!(!compiled.generic_css.contains("#google_ads_iframe_*"));
        assert!(!compiled.generic_css.contains(":remove("));
    }

    #[test]
    fn compile_active_filter_index_skips_denylisted_gmail_selectors() {
        let compiled = compile_active_filter_index_internal(
            FilterSourceBundle {
                cosmetic: FilterSourceCosmetic {
                    generic: Vec::new(),
                    domain_specific: HashMap::new(),
                    exceptions: HashMap::new(),
                },
                scriptlets: Vec::new(),
            },
            vec![FilterSourceBundle {
                cosmetic: FilterSourceCosmetic {
                    generic: Vec::new(),
                    domain_specific: HashMap::from([(
                        "mail.google.com".to_string(),
                        vec![
                            ".nH.PS".to_string(),
                            ".aeF > .nH > .nH[role=\"main\"] > .aKB".to_string(),
                            "a[href^=\"http://li.blogtrottr.com/click?\"]".to_string(),
                        ],
                    )]),
                    exceptions: HashMap::new(),
                },
                scriptlets: Vec::new(),
            }],
            100,
        )
        .expect("under the input cap");

        let domain_specific = compiled.cosmetic.domain_specific["mail.google.com"].clone();
        let exceptions = Vec::new();

        let bundle = build_page_bundle_internal(Vec::new(), domain_specific, exceptions, 100);

        assert!(bundle
            .css_text
            .contains("a[href^=\"http://li.blogtrottr.com/click?\"]"));
        assert!(!bundle.css_text.contains(".nH.PS"));
        assert!(!bundle
            .css_text
            .contains(".aeF > .nH > .nH[role=\"main\"] > .aKB"));
        assert!(bundle.exception_css.is_empty());
    }

    // §4.1 — the Rust hash must be bit-identical to the JS one. Golden
    // vectors computed by src/shared/bloom.js (`_hash(key, seed) % size`,
    // size = 256 * 1024, seeds 0..4). The same values are asserted on the JS
    // side in src/shared/bloom.test.mjs — if either engine drifts, its half
    // of the pair fails.
    #[test]
    fn bloom_hash_matches_js_bit_indices() {
        let size = 256 * 1024;
        let filter = BloomFilter::new(size, 4);
        let indices = |key: &str| -> Vec<usize> {
            (0..4u8)
                .map(|seed| (filter.calculate_hash(key, seed) as usize) % size)
                .collect()
        };

        assert_eq!(
            filter.calculate_hash("example.com", 0),
            1_125_968_678,
            "raw 32-bit hash must match bloom.js"
        );
        assert_eq!(indices("example.com"), vec![60198, 41457, 105056, 128235]);
        assert_eq!(
            indices("ads.example.com"),
            vec![65278, 200453, 245808, 110063]
        );
        assert_eq!(
            indices("tracker.evil.example"),
            vec![46029, 30112, 29635, 78086]
        );
        assert_eq!(indices(""), vec![40389, 40388, 40391, 40390]);
    }

    // §4.1 — serialized payloads carry a format tag; legacy payloads without
    // one still load (they used the same JS hash), and an unknown future
    // format degrades to the safe empty filter instead of cross-loading
    // incompatible bits.
    #[test]
    fn bloom_serialization_is_versioned_and_accepts_legacy_payloads() {
        let mut original = BloomFilter::new(1024, 4);
        original.add("example.com");
        let json = original.serialize_to_json().unwrap();
        assert!(json.contains("\"format\":1"), "serializer must tag: {json}");

        let mut legacy: serde_json::Value = serde_json::from_str(&json).unwrap();
        legacy.as_object_mut().unwrap().remove("format");
        let restored = BloomFilter::deserialize_from_json(&legacy.to_string());
        assert!(restored.has("example.com"), "legacy payloads must load");

        let mut future: serde_json::Value = serde_json::from_str(&json).unwrap();
        future["format"] = serde_json::json!(999);
        let refused = BloomFilter::deserialize_from_json(&future.to_string());
        assert!(
            !refused.has("example.com"),
            "unknown format must fall back to the empty filter"
        );
    }

    // §4.35 — `;` is legal inside a `:style(...)` argument (uBO ships
    // multi-declaration style rules); everywhere else it stays rejected, as
    // do braces and NULs.
    #[test]
    fn style_operator_arguments_may_contain_semicolons() {
        assert!(is_valid_selector(
            ".widget:style(-webkit-user-select: text !important; user-select: text !important)"
        ));
        assert!(is_valid_selector(
            "div:style(a: 1; b: 2):style(c: 3; d: 4)"
        ));

        assert!(!is_valid_selector("div; body"));
        assert!(!is_valid_selector(".x:style(a: 1) ; div"));
        assert!(!is_valid_selector(".x:style(a: 1;"), "unbalanced :style(");
        assert!(!is_valid_selector(".x:style(a{b})"), "braces stay rejected");

        let compiled = compile_user_filters_internal(
            "example.com##.hero:style(position: absolute !important; top: -9999px)",
            1,
        );
        assert_eq!(
            compiled.cosmetic_rules.domain_specific["example.com"].len(),
            1,
            "the :style rule must survive ingestion"
        );
    }

    // §4.35 — the ingested `:style` rule must reach the procedural planner
    // with its full multi-declaration argument intact.
    #[test]
    fn style_rules_with_semicolons_reach_the_procedural_plan() {
        let bundle = build_page_bundle_internal(
            Vec::new(),
            vec![".hero:style(a: 1 !important; b: 2)".into()],
            Vec::new(),
            100,
        );

        assert_eq!(bundle.rules.domain_specific.len(), 1);
        let plan = &bundle.rules.domain_specific[0].plan;
        assert!(
            plan.iter().any(|step| step.op.as_deref() == Some("style")
                && step.arg.as_deref() == Some("a: 1 !important; b: 2")),
            "plan must contain the style op with the ;-bearing argument"
        );
    }

    // §4.35 — `div *` is a valid descendant-universal selector; only a `*`
    // glued to the preceding token (`div*`) is the bypass shape. The old scan
    // skipped whitespace and conflated the two, silently dropping shipped
    // selectors.
    #[test]
    fn descendant_universal_selectors_are_valid_but_glued_ones_are_not() {
        assert!(is_css_safe_selector("div *"));
        assert!(is_css_safe_selector(".ad-container > *"));
        assert!(!has_invalid_universal_usage("div *"));
        assert!(!has_invalid_universal_usage("li > div *"));

        assert!(has_invalid_universal_usage("div*"));
        assert!(has_invalid_universal_usage(".class*"));
        assert!(has_invalid_universal_usage("[data-ad]*"));
        assert!(!is_css_safe_selector("div*"));
    }

    // §5.22 — behavior pinned across the allocation-free rewrite.
    #[test]
    fn universal_usage_scan_keeps_pseudo_element_and_quote_semantics() {
        assert!(!has_invalid_universal_usage("div::before"));
        assert!(!has_invalid_universal_usage("input::placeholder"));
        assert!(has_invalid_universal_usage("div::malicious"));
        // `*` inside brackets/quotes is not a universal selector
        assert!(!has_invalid_universal_usage("a[href*=\"ads\"]"));
        assert!(!has_invalid_universal_usage("a[title=\"x*y\"]"));
    }

    // §4.36 — `@@…$generichide`-family user filters must never degrade into
    // blanket network allows; the pipeline has no cosmetic-scope channel for
    // user filters, so they are dropped and counted.
    #[test]
    fn elemhide_family_exceptions_never_become_network_allows() {
        for opt in [
            "elemhide",
            "ehide",
            "generichide",
            "ghide",
            "specifichide",
            "shide",
        ] {
            let line = format!("@@||example.com^${opt}");
            let compiled = compile_user_filters_internal(&line, 1);
            assert!(
                compiled.dnr_rules.is_empty(),
                "@@…${opt} must not emit a network rule"
            );
        }

        let combined =
            compile_user_filters_internal("@@||example.com^$generichide,domain=example.com", 1);
        assert!(combined.dnr_rules.is_empty());

        // A plain exception still compiles to a network allow.
        let plain = compile_user_filters_internal("@@||example.com^", 1);
        assert_eq!(plain.dnr_rules.len(), 1);
        assert_eq!(plain.dnr_rules[0].action.action_type, "allow");
    }

    // §5.17 — argument interiors keep their quote characters, matching the
    // JS parsers; only one surrounding quote pair is stripped.
    #[test]
    fn scriptlet_args_preserve_interior_quotes() {
        assert_eq!(
            parse_scriptlet_args("set, div[id='ad'], x"),
            vec![
                "set".to_string(),
                "div[id='ad']".to_string(),
                "x".to_string()
            ]
        );
        assert_eq!(
            parse_scriptlet_args("foo, 'a, b', c"),
            vec!["foo".to_string(), "a, b".to_string(), "c".to_string()]
        );
        assert_eq!(
            parse_scriptlet_args("foo, \"x, y\", 'z'"),
            vec!["foo".to_string(), "x, y".to_string(), "z".to_string()]
        );
    }

    // §5.17 — an unpaired quote must not leave the quote state open and
    // swallow every subsequent comma.
    #[test]
    fn scriptlet_args_with_unpaired_quote_do_not_merge() {
        assert_eq!(
            parse_scriptlet_args("aopr, don't, x"),
            vec!["aopr".to_string(), "don't".to_string(), "x".to_string()]
        );
    }

    // §5.18 — a `#@#` exception carrying a procedural selector is not CSS,
    // but it must still suppress the matching procedural rule.
    #[test]
    fn procedural_exceptions_suppress_procedural_rules() {
        let bundle = build_page_bundle_internal(
            Vec::new(),
            vec![
                "div:has-text(Ad):upward(1)".into(),
                ".plain-ad".into(),
            ],
            vec!["div:has-text(Ad):upward(1)".into()],
            100,
        );

        assert!(
            bundle.rules.domain_specific.is_empty(),
            "the excepted procedural rule must be suppressed"
        );
        assert!(bundle.css_text.contains(".plain-ad"));
        // Procedural exceptions are not stylesheet material: they must not
        // leak into the revert CSS or the transported exception list.
        assert!(bundle.exception_css.is_empty());
        assert!(bundle.rules.exceptions.is_empty());
    }

    // §5.19 — a NUL would desync the NUL-terminated binary rule framing and
    // shift every subsequent entry; it is rejected at ingestion.
    #[test]
    fn nul_bytes_are_rejected_before_binary_framing() {
        assert!(!is_valid_selector("div\0.ad"));
        let compiled = compile_user_filters_internal("example.com##div\0.ad", 1);
        assert!(compiled.cosmetic_rules.domain_specific.is_empty());
    }

    // §5.20 — oversized inputs are refused with a structured error instead
    // of being processed (WASM linear memory never shrinks).
    #[test]
    fn oversized_inputs_are_refused_with_a_structured_error() {
        let big = "x".repeat(MAX_USER_FILTER_BYTES + 1);
        let err = match compile_user_filters_checked(&big, 1) {
            Err(err) => err,
            Ok(_) => panic!("oversized input must be refused"),
        };
        assert!(err.contains("\"error\":\"input_too_large\""), "{err}");
        assert!(err.contains("\"function\":\"compile_user_filters\""));
        assert!(err.contains(&format!("\"max\":{MAX_USER_FILTER_BYTES}")));

        let big_source = "y".repeat(MAX_FILTER_SOURCE_BYTES + 1);
        assert!(parse_filter_source_checked(&big_source).is_err());

        let big_player = "z".repeat(MAX_YT_PLAYER_BYTES + 1);
        assert!(process_youtube_player_checked(&big_player).is_err());

        let oversized_index = FilterSourceBundle {
            cosmetic: FilterSourceCosmetic {
                generic: vec![".x".to_string(); MAX_INDEX_INPUT_ENTRIES + 1],
                ..Default::default()
            },
            scriptlets: Vec::new(),
        };
        assert!(compile_active_filter_index_internal(oversized_index, Vec::new(), 100).is_err());

        // Sanity: ordinary inputs still pass every guard.
        assert!(compile_user_filters_checked("##.ad", 1).is_ok());
        assert!(parse_filter_source_checked("##.ad").is_ok());
        assert!(process_youtube_player_checked("{}").is_ok());
    }

    // §5.20 — the entry counter behind the index cap counts every class of
    // entry a source contributes.
    #[test]
    fn filter_source_entry_count_covers_all_entry_classes() {
        let source = FilterSourceBundle {
            cosmetic: FilterSourceCosmetic {
                generic: vec![".a".into()],
                domain_specific: HashMap::from([(
                    "d.com".to_string(),
                    vec![".b".to_string(), ".c".to_string()],
                )]),
                exceptions: HashMap::from([("d.com".to_string(), vec![".d".to_string()])]),
            },
            scriptlets: vec![ParsedRule::default()],
        };
        assert_eq!(filter_source_entry_count(&source), 5);
    }

    // §5.21 — the procedural-plan JSON carries a version field, and legacy
    // payloads (no version, missing bundle fields) deserialize instead of
    // hard-failing the compile.
    #[test]
    fn plan_json_is_versioned_and_legacy_payloads_deserialize() {
        let planned = plan_selector_rules_json("[\"div:has-text(Ad)\"]");
        let parsed: serde_json::Value = serde_json::from_str(&planned).unwrap();
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["proceduralRules"][0]["planVersion"], 1);

        let legacy_rule: PlannedSelectorRule =
            serde_json::from_str("{\"selector\":\".x\",\"plan\":[]}").unwrap();
        assert_eq!(legacy_rule.plan_version, PLAN_FORMAT_VERSION);

        let empty: FilterSourceBundle = serde_json::from_str("{}").unwrap();
        assert!(empty.cosmetic.generic.is_empty());
        assert!(empty.scriptlets.is_empty());

        let partial: FilterSourceBundle =
            serde_json::from_str("{\"cosmetic\":{\"generic\":[\".ad\"]}}").unwrap();
        assert_eq!(partial.cosmetic.generic, vec![".ad".to_string()]);

        let sparse_rule: ParsedRule = serde_json::from_str("{\"type\":\"scriptlet\"}").unwrap();
        assert_eq!(sparse_rule.rule_type, "scriptlet");
        assert!(sparse_rule.domains.is_empty());
    }

    // §5.23 — the fragment survives sanitization and keys are matched
    // exactly: `ref` on the strip list must not take `referral_code` with it.
    #[test]
    fn url_sanitizer_preserves_fragment_and_matches_keys_exactly() {
        let sanitizer = UrlSanitizer::new("ref,utm_source");

        assert_eq!(
            sanitizer.sanitize("https://x.example/p?ref=1&referral_code=abc&utm_source=nl#frag"),
            "https://x.example/p?referral_code=abc#frag"
        );
        assert_eq!(
            sanitizer.sanitize("https://x.example/p?ref=1#frag"),
            "https://x.example/p#frag"
        );
        assert_eq!(
            sanitizer.sanitize("https://x.example/p#frag"),
            "https://x.example/p#frag"
        );
        assert_eq!(
            sanitizer.sanitize("https://x.example/p?a=1&utm_source=x"),
            "https://x.example/p?a=1"
        );
        assert_eq!(
            sanitizer.sanitize("https://x.example/p"),
            "https://x.example/p"
        );
    }
}

// ---------------------------------------------------------------------------
// Semantic Hiding Engine
// ---------------------------------------------------------------------------

fn ad_keyword_ac() -> &'static AhoCorasick {
    static AC: OnceLock<AhoCorasick> = OnceLock::new();
    AC.get_or_init(|| {
        AhoCorasick::new([
            "sponsored",
            "promoted",
            "advertisement",
            "adsby",
            "suggestedpost",
            "recommendedforyou",
            "marketingshare",
            "sponsoredpost",
            "paidpost",
            "publicidad",
            "patrocinado",
            "anuncio",
            "anzeige",
            "gesponsert",
            "publicit",
            "sponsoris",
            "pubblicit",
            "sponsorizzato",
            "reklama",
            "sponsorowane",
        ])
        .unwrap()
    })
}

#[wasm_bindgen]
pub fn is_semantic_ad(text: &str) -> bool {
    // Normalize once, then do a single O(n) multi-pattern scan.
    let normalized: String = text
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    if normalized.is_empty() {
        return false;
    }
    ad_keyword_ac().is_match(&normalized)
}
