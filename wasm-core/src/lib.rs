use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::collections::{HashMap, HashSet};
use aho_corasick::AhoCorasick;
use rand::prelude::*;
use rand::rngs::SmallRng;
use rand_distr::{Distribution, Normal};

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
        let s: SerializedBloom = serde_json::from_str(json).unwrap();
        Self {
            size: s.size,
            hashes: s.hashes,
            bitset: s.data,
        }
    }

    pub fn check_hostname(&self, hostname: &str) -> bool {
        if self.has("") { return true; } 
        let mut d = hostname;
        loop {
            if self.has(d) { return true; }
            match d.find('.') {
                Some(idx) => d = &d[idx + 1..],
                None => break,
            }
        }
        false
    }
}

#[wasm_bindgen]
pub fn check_allowlist_csv(hostname: &str, allowlist_csv: &str) -> bool {
    let mut d = hostname;
    loop {
        for domain in allowlist_csv.split(',') {
            if domain.trim() == d { return true; }
        }
        match d.find('.') {
            Some(idx) => d = &d[idx + 1..],
            None => break,
        }
    }
    false
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

#[wasm_bindgen]
pub fn parse_filter_list_to_json(text: &str) -> String {
    let mut cosmetic_rules = Vec::new();
    let mut scriptlet_rules = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('!') || line.starts_with('[') {
            continue;
        }

        if let Some(rule) = parse_line(line) {
            match rule.rule_type.as_str() {
                "cosmetic" => cosmetic_rules.push(rule),
                "scriptlet" => scriptlet_rules.push(rule),
                _ => {}
            }
        }
    }

    let result = serde_json::json!({
        "cosmeticRules": cosmetic_rules,
        "scriptletRules": scriptlet_rules,
    });
    result.to_string()
}

#[wasm_bindgen]
pub fn compile_filters_to_dnr_json(text: &str, mut start_id: u32) -> String {
    let mut rules = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('!') || line.starts_with('[') { continue; }
        if line.contains("##") || line.contains("#@#") { continue; }

        if let Some(dnr_rule) = parse_network_rule_to_dnr(line, start_id) {
            rules.push(dnr_rule);
            start_id += 1;
        }
    }
    serde_json::to_string(&rules).unwrap_or_else(|_| "[]".to_string())
}

#[derive(Serialize, Deserialize)]
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
pub struct DnrRule { id: u32, priority: u8, action: DnrAction, condition: DnrCondition }
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
            if !is_important { return None; } // Skip blocking this critical path
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

    let priority = if is_exception { 10u8 } else if is_important { 5u8 } else { 1u8 };

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
        let ac = AhoCorasick::new(&patterns).unwrap();
        Self { ac }
    }
    pub fn matches(&self, text: &str) -> bool { self.ac.is_match(text) }
}

// ---------------------------------------------------------------------------
// Stealth Noise
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn generate_gaussian_noise(mean: f64, std_dev: f64, seed: f64) -> f64 {
    let dist = Normal::new(mean, std_dev).unwrap();
    let mut rng = SmallRng::seed_from_u64(seed as u64);
    dist.sample(&mut rng)
}

// ---------------------------------------------------------------------------
// Rule Optimizer
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn optimize_cosmetic_rules_csv(generic_csv: &str, domain_specific_json: &str) -> String {
    let generic_set: HashSet<&str> = generic_csv.split('\n').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let mut domain_map: HashMap<String, Vec<String>> = serde_json::from_str(domain_specific_json).unwrap_or_default();
    for (_domain, rules) in domain_map.iter_mut() {
        rules.retain(|r| !generic_set.contains(r.as_str()));
    }
    domain_map.retain(|_, rules| !rules.is_empty());
    serde_json::to_string(&domain_map).unwrap_or_else(|_| "{}".to_string())
}

// ---------------------------------------------------------------------------
// CSS Selector Sanitizer & Compactor
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn sanitize_and_compact_selectors(csv: &str, chunk_size: usize) -> String {
    let mut chunks = Vec::new();
    let mut current_chunk = Vec::new();
    
    for s in csv.split('\n') {
        let s = s.trim();
        if s.is_empty() { continue; }

        if s.contains('{') || s.contains('}') || s.contains(';') {
            continue; 
        }

        let is_risky = s.contains(':') && (s.contains("nth-") || s.contains("not(") || s.contains("has("));

        if is_risky {
            chunks.push(format!("{} {{ display: none !important; visibility: hidden !important; }}", s));
        } else {
            current_chunk.push(s);
            if current_chunk.len() >= chunk_size {
                chunks.push(format!("{} {{ display: none !important; visibility: hidden !important; }}", current_chunk.join(",")));
                current_chunk.clear();
            }
        }
    }

    if !current_chunk.is_empty() {
        chunks.push(format!("{} {{ display: none !important; visibility: hidden !important; }}", current_chunk.join(",")));
    }

    chunks.join("\n")
}

// ---------------------------------------------------------------------------
// Binary Rule Transfer
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn serialize_rules_to_binary_from_json(generic_json: &str, domain_specific_json: &str, exceptions_json: &str) -> Vec<u8> {
    let mut buffer = Vec::new();
    let write_list = |buf: &mut Vec<u8>, json: &str| {
        let list: Vec<String> = serde_json::from_str(json).unwrap_or_default();
        buf.extend_from_slice(&(list.len() as u32).to_le_bytes());
        for s in list { buf.extend_from_slice(s.as_bytes()); buf.push(0); }
    };
    write_list(&mut buffer, generic_json);
    write_list(&mut buffer, domain_specific_json);
    write_list(&mut buffer, exceptions_json);
    buffer
}

// ---------------------------------------------------------------------------
// URL Sanitizer
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn sanitize_url_with_csv(url: &str, patterns_csv: &str) -> String {
    if !url.contains('?') { return url.into(); }
    let patterns: Vec<&str> = patterns_csv.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let ac = AhoCorasick::new(&patterns).unwrap();
    let parts: Vec<&str> = url.splitn(2, '?').collect();
    let mut pairs: Vec<&str> = parts[1].split('&').collect();
    pairs.retain(|pair| !ac.is_match(pair.split('=').next().unwrap_or("")));
    if pairs.is_empty() { parts[0].into() } else { format!("{}?{}", parts[0], pairs.join("&")) }
}

// ---------------------------------------------------------------------------
// Differential Privacy Reporter
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn anonymize_stats_json(json: &str, noise_scale: f64, seed: f64) -> String {
    let mut data: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let dist = Normal::new(0.0, noise_scale).unwrap();
    let mut rng = SmallRng::seed_from_u64(seed as u64);

    if let Some(obj) = data.as_object_mut() {
        for (_key, value) in obj.iter_mut() {
            if let Some(count) = value.as_f64() {
                let noise = dist.sample(&mut rng);
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
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn clean_youtube_json(text: &str) -> String {
    let ad_keys = [
        "\"adPlacements\":",
        "\"adSlots\":",
        "\"playerAds\":",
        "\"adBreakHeartbeatParams\":",
        "\"adClientParams\":"
    ];
    let replacements = [
        "\"disabled_adPlacements\":",
        "\"disabled_adSlots\":",
        "\"disabled_playerAds\":",
        "\"disabled_adBreakHeartbeatParams\":",
        "\"disabled_adClientParams\":"
    ];

    let ac = match AhoCorasick::new(&ad_keys) {
        Ok(ac) => ac,
        Err(_) => return text.to_string(),
    };

    let mut result = String::with_capacity(text.len());
    ac.replace_all_with(text, &mut result, |mat, _, dst| {
        dst.push_str(replacements[mat.pattern().as_usize()]);
        true
    });

    result
}

#[wasm_bindgen]
pub fn clean_youtube_binary(data: &[u8]) -> Vec<u8> {
    let ad_keys: &[&[u8]] = &[
        b"\"adPlacements\":",
        b"\"adSlots\":",
        b"\"playerAds\":",
        b"\"adBreakHeartbeatParams\":",
        b"\"adClientParams\":"
    ];
    let replacements: &[&[u8]] = &[
        b"\"disabled_adPlacements\":",
        b"\"disabled_adSlots\":",
        b"\"disabled_playerAds\":",
        b"\"disabled_adBreakHeartbeatParams\":",
        b"\"disabled_adClientParams\":"
    ];

    let ac = match AhoCorasick::new(ad_keys) {
        Ok(ac) => ac,
        Err(_) => return data.to_vec(),
    };

    let mut result = Vec::with_capacity(data.len());
    ac.replace_all_with_bytes(data, &mut result, |mat, _, dst| {
        dst.extend_from_slice(replacements[mat.pattern().as_usize()]);
        true
    });

    result
}

#[wasm_bindgen]
pub fn sanitize_youtube_experiments(json_text: &str) -> String {
    // 2026-era SSAI and Anti-Adblock experiment flags to neutralize
    let poison_list = [
        "\"web_player_api_v2_server_side_ad_injection\":true",
        "\"web_enable_ab_wv_edu\":true",
        "\"web_enable_ad_signals\":true",
        "\"web_player_api_v2_ad_break_heartbeat_params\":true",
        "\"web_disable_midroll_ads\":false",
        "\"web_enable_ab_wv_edu_v2\":true",
        "\"web_enable_ab_wv_edu_v3\":true",
        "\"web_player_api_v2_ads_metadata\":true",
        "\"web_enable_ad_break_heartbeat\":true"
    ];
    
    let clean_list = [
        "\"web_player_api_v2_server_side_ad_injection\":false",
        "\"web_enable_ab_wv_edu\":false",
        "\"web_enable_ad_signals\":false",
        "\"web_player_api_v2_ad_break_heartbeat_params\":false",
        "\"web_disable_midroll_ads\":true",
        "\"web_enable_ab_wv_edu_v2\":false",
        "\"web_enable_ab_wv_edu_v3\":false",
        "\"web_player_api_v2_ads_metadata\":false",
        "\"web_enable_ad_break_heartbeat\":false"
    ];

    let ac = match AhoCorasick::new(&poison_list) {
        Ok(ac) => ac,
        Err(_) => return json_text.to_string(),
    };

    let mut result = String::with_capacity(json_text.len());
    ac.replace_all_with(json_text, &mut result, |mat, _, dst| {
        dst.push_str(clean_list[mat.pattern().as_usize()]);
        true
    });

    result
}

// ---------------------------------------------------------------------------
// Semantic Hiding Engine
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn is_semantic_ad(text: &str) -> bool {
    let normalized: String = text.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();

    if normalized.is_empty() { return false; }

    let ad_keywords = [
        "sponsored", "promoted", "advertisement", "adsby", "suggestedpost",
        "recommendedforyou", "marketingshare", "sponsoredpost", "paidpost",
        "publicidad", "patrocinado", "anuncio", 
        "anzeige", "gesponsert", 
        "publicit", "sponsoris", 
        "pubblicit", "sponsorizzato", 
        "reklama", "sponsorowane", 
    ];

    for &word in ad_keywords.iter() {
        if normalized.contains(word) {
            return true;
        }
    }

    false
}
