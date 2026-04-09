use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use rustc_hash::FxHasher;
use std::hash::{Hash, Hasher};

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
        let mut hasher = FxHasher::default();
        key.hash(&mut hasher);
        seed.hash(&mut hasher);
        hasher.finish()
    }

    pub fn serialize(&self) -> JsValue {
        let serialized = SerializedBloom {
            size: self.size,
            hashes: self.hashes,
            data: self.bitset.clone(),
        };
        serde_wasm_bindgen::to_value(&serialized).unwrap()
    }

    pub fn deserialize(val: JsValue) -> Self {
        let s: SerializedBloom = serde_wasm_bindgen::from_value(val).unwrap();
        Self {
            size: s.size,
            hashes: s.hashes,
            bitset: s.data,
        }
    }

    /// Check if a hostname or any of its parent domains are in the filter.
    /// This avoids multiple JS/WASM crossings.
    pub fn check_hostname(&self, hostname: &str) -> bool {
        if self.has("") { return true; } // Generic rules present
        
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
pub fn check_allowlist(hostname: &str, allowlist_json: JsValue) -> bool {
    let allowlist: Vec<String> = serde_wasm_bindgen::from_value(allowlist_json).unwrap_or_default();
    if allowlist.is_empty() { return false; }

    let mut d = hostname;
    loop {
        if allowlist.iter().any(|domain| domain == d) {
            return true;
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
// Filter Parser
// ---------------------------------------------------------------------------

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

#[derive(Serialize, Deserialize)]
pub struct ParseResult {
    #[serde(rename = "cosmeticRules")]
    cosmetic_rules: Vec<ParsedRule>,
    #[serde(rename = "scriptletRules")]
    scriptlet_rules: Vec<ParsedRule>,
}

#[wasm_bindgen]
pub fn parse_filter_list(text: &str) -> JsValue {
    let mut cosmetic_rules = Vec::new();
    let mut scriptlet_rules = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('!') || line.starts_with('[') || 
           line.starts_with('%') || line.starts_with("@@#") {
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

    let result = ParseResult {
        cosmetic_rules,
        scriptlet_rules,
    };
    serde_wasm_bindgen::to_value(&result).unwrap()
}

fn parse_line(line: &str) -> Option<ParsedRule> {
    // Basic detection of rule type via separator
    if line.contains("##+js(") || line.contains("#+js(") {
        return parse_scriptlet(line);
    }
    
    if let Some(idx) = line.find("#@#") {
        let domains = &line[..idx];
        let selector = &line[idx + 3..];
        return Some(ParsedRule {
            rule_type: "cosmetic".to_string(),
            domains: parse_domains(domains),
            selector: Some(selector.to_string()),
            exception: Some(true),
            name: None,
            args: None,
        });
    }

    if let Some(idx) = line.find("#?#") {
        let domains = &line[..idx];
        let selector = &line[idx + 3..];
        return Some(ParsedRule {
            rule_type: "cosmetic".to_string(),
            domains: parse_domains(domains),
            selector: Some(selector.to_string()),
            exception: Some(false),
            name: None,
            args: None,
        });
    }

    if let Some(idx) = line.find("##") {
        let domains = &line[..idx];
        let selector = &line[idx + 2..];
        return Some(ParsedRule {
            rule_type: "cosmetic".to_string(),
            domains: parse_domains(domains),
            selector: Some(selector.to_string()),
            exception: Some(false),
            name: None,
            args: None,
        });
    }

    None
}

fn parse_domains(domains: &str) -> Vec<String> {
    if domains.is_empty() {
        return Vec::new();
    }
    domains.split(',')
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .collect()
}

fn parse_scriptlet(line: &str) -> Option<ParsedRule> {
    // example.com##+js(name, arg1, arg2)
    let (domains, rest) = if let Some(idx) = line.find("##+js(") {
        (&line[..idx], &line[idx + 6..line.len() - 1])
    } else if let Some(idx) = line.find("#+js(") {
        (&line[..idx], &line[idx + 5..line.len() - 1])
    } else {
        return None;
    };

    let args = parse_scriptlet_args(rest);
    if args.is_empty() {
        return None;
    }

    let mut args_iter = args.into_iter();
    let name = args_iter.next()?;
    let rest_args: Vec<String> = args_iter.collect();

    Some(ParsedRule {
        rule_type: "scriptlet".to_string(),
        domains: parse_domains(domains),
        selector: None,
        exception: None,
        name: Some(name),
        args: Some(rest_args),
    })
}

fn parse_scriptlet_args(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;

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
    if !current.trim().is_empty() {
        args.push(current.trim().trim_matches(|c| c == '\'' || c == '"').to_string());
    }
    args
}
