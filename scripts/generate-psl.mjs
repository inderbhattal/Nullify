#!/usr/bin/env node
/**
 * generate-psl.mjs
 *
 * Generates Rust PSL constants from the JavaScript source file.
 * This ensures the JS and Rust PSL lists stay in sync.
 *
 * Usage:
 *   node scripts/generate-psl.mjs
 *
 * Output: wasm-core/src/psl_generated.rs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PSL_JS_PATH = path.resolve(__dirname, '../src/shared/psl.js');
const PSL_RS_PATH = path.resolve(__dirname, '../wasm-core/src/psl_generated.rs');

function extractPslEntries(jsContent) {
  // Match the PUBLIC_SUFFIXES Set definition - capture everything between [ and ]
  const setMatch = jsContent.match(/const PUBLIC_SUFFIXES = new Set\(\[([\s\S]*?)\]\);/);
  if (!setMatch) {
    throw new Error('Could not find PUBLIC_SUFFIXES Set in psl.js');
  }

  const entriesBlock = setMatch[1];
  const entries = [];

  // Match all string literals (single or double quoted)
  const stringRegex = /['"]([^'"]+)['"]/g;
  let match;
  while ((match = stringRegex.exec(entriesBlock)) !== null) {
    entries.push(match[1]);
  }

  return entries;
}

function generateRustFile(entries) {
  const header = `// Auto-generated from src/shared/psl.js
// DO NOT EDIT MANUALLY
// Run: node scripts/generate-psl.mjs

use std::collections::HashSet;
use std::sync::OnceLock;

/// Public suffix set — generated from src/shared/psl.js
pub fn public_suffixes_generated() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
${entries.map(e => `            "${e}",`).join('\n')}
        ].into_iter().collect()
    })
}
`;

  return header;
}

function main() {
  console.log('[PSL] Generating Rust PSL constants from JavaScript source...\n');

  if (!fs.existsSync(PSL_JS_PATH)) {
    console.error(`[PSL] Error: ${PSL_JS_PATH} not found`);
    process.exit(1);
  }

  const jsContent = fs.readFileSync(PSL_JS_PATH, 'utf8');
  const entries = extractPslEntries(jsContent);

  console.log(`[PSL] Extracted ${entries.length} public suffix entries from psl.js`);

  const rustContent = generateRustFile(entries);
  fs.writeFileSync(PSL_RS_PATH, rustContent);

  console.log(`[PSL] Generated ${PSL_RS_PATH}`);
  console.log(`[PSL] Complete: ${entries.length} entries written`);
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('[PSL] Fatal error:', err);
  process.exit(1);
}
