import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeBinaryRules,
  decodeBinaryPayload,
  decodeBinaryRules,
  resolvePageRules,
  PLAN_FORMAT_VERSION,
} from './rule-transport.js';

/** Build the wire format the Rust side emits: three [u32 count][NUL-terminated strings] lists. */
function buildBinary(generic, domainSpecific, exceptions) {
  const parts = [];
  const enc = new TextEncoder();

  for (const list of [generic, domainSpecific, exceptions]) {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, list.length, true);
    parts.push(count);
    for (const entry of list) {
      parts.push(enc.encode(entry));
      parts.push(new Uint8Array([0]));
    }
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** What chrome.runtime messaging actually does to a response object. */
const overTheBus = (value) => JSON.parse(JSON.stringify(value));

const PROCEDURAL = '{"selector":"div:has-text(Ad)","plan":[{"type":"css","selector":"div"}]}';

test('a raw Uint8Array does not survive the message bus — the reason this module exists', () => {
  const bytes = buildBinary([], [PROCEDURAL], []);
  const received = overTheBus({ cosmeticRulesBinary: bytes }).cosmeticRulesBinary;

  assert.ok(!(received instanceof Uint8Array), 'arrives as a plain object');
  assert.equal(received.buffer, undefined, 'so DataView construction would throw');
});

test('base64 payload survives the message bus and round-trips exactly', () => {
  const bytes = buildBinary(['.a'], [PROCEDURAL], ['.keep']);
  const encoded = encodeBinaryRules(bytes);

  const received = overTheBus({ cosmeticRulesBinary: encoded }).cosmeticRulesBinary;
  const decoded = decodeBinaryPayload(received);

  assert.ok(decoded instanceof Uint8Array);
  assert.deepEqual([...decoded], [...bytes]);
});

test('decodes the three rule lists, parsing procedural plans', () => {
  const bytes = buildBinary(['.generic-ad'], [PROCEDURAL], ['.false-positive']);
  const rules = decodeBinaryRules(decodeBinaryPayload(encodeBinaryRules(bytes)));

  assert.deepEqual(rules.generic, ['.generic-ad']);
  assert.deepEqual(rules.exceptions, ['.false-positive']);
  assert.equal(rules.domainSpecific.length, 1);
  assert.equal(rules.domainSpecific[0].selector, 'div:has-text(Ad)');
});

test('resolvePageRules: procedural rules survive a full response round-trip', () => {
  // The regression: the SW attached a Uint8Array and deleted the JSON rules,
  // so the content script threw on decode and applied no procedural rules.
  const response = {
    isAllowed: false,
    cosmeticRules: { generic: [], domainSpecific: [], exceptions: [] },
    cosmeticRulesBinary: encodeBinaryRules(buildBinary([], [PROCEDURAL], ['.keep'])),
    genericProceduralRules: [],
  };

  const rules = resolvePageRules(overTheBus(response));

  assert.equal(rules.domainSpecific.length, 1, 'procedural rule must reach the engine');
  assert.equal(rules.domainSpecific[0].selector, 'div:has-text(Ad)');
  assert.deepEqual(rules.exceptions, ['.keep']);
});

test('resolvePageRules: falls back to JSON rules when the binary is unusable', () => {
  const jsonRules = {
    generic: ['.j-generic'],
    domainSpecific: ['.j-domain'],
    exceptions: ['.j-exception'],
  };

  for (const bad of [undefined, null, '', 'not base64 !!!', { 0: 1, 1: 2 }]) {
    const rules = resolvePageRules({ cosmeticRules: jsonRules, cosmeticRulesBinary: bad });
    assert.deepEqual(rules.generic, ['.j-generic'], `fallback for ${JSON.stringify(bad)}`);
    assert.deepEqual(rules.domainSpecific, ['.j-domain']);
    assert.deepEqual(rules.exceptions, ['.j-exception']);
  }
});

test('resolvePageRules: merges generic procedural rules ahead of page rules', () => {
  const rules = resolvePageRules({
    cosmeticRules: { generic: [], domainSpecific: ['.page'], exceptions: [] },
    genericProceduralRules: ['.global'],
  });

  assert.deepEqual(rules.domainSpecific, ['.global', '.page']);
});

test('resolvePageRules: tolerates a missing or empty response', () => {
  for (const empty of [undefined, null, {}]) {
    const rules = resolvePageRules(empty);
    assert.deepEqual(rules, { generic: [], domainSpecific: [], exceptions: [] });
  }
});

test('encodeBinaryRules: nothing to send yields null, not an empty payload', () => {
  assert.equal(encodeBinaryRules(null), null);
  assert.equal(encodeBinaryRules(new Uint8Array(0)), null);
});

test('encodeBinaryRules: handles payloads larger than one encode chunk', () => {
  const big = buildBinary([], Array.from({ length: 6000 }, (_, i) => `.selector-${i}`), []);
  assert.ok(big.length > 0x8000, 'fixture must exceed the chunk size');

  const rules = decodeBinaryRules(decodeBinaryPayload(encodeBinaryRules(big)));
  assert.equal(rules.domainSpecific.length, 6000);
  assert.equal(rules.domainSpecific[5999], '.selector-5999');
});

// --- §5.8: structural damage must be reported, never applied partially -----
//
// `readStringList` used to return whatever it had accumulated when the bytes
// ran out, so `decodeBinaryRules` was structurally incapable of returning a
// falsy value and the JSON fallback could never fire for structural damage.

test('5.8: a truncated payload decodes to null instead of a silent partial rule set', () => {
  const full = buildBinary([], [PROCEDURAL, '{"selector":"#a","plan":[]}'], ['.keep']);
  const truncated = full.slice(0, full.length - 20);

  assert.ok(decodeBinaryRules(full), 'the intact payload must still decode');
  assert.equal(decodeBinaryRules(truncated), null, 'truncation must be reported, not absorbed');
});

test('5.8: truncation no longer leaks half-JSON into domainSpecific as a selector', () => {
  // The observed damage: the `.keep` exception vanished entirely and the
  // half-read tail `{"selector":"#a","` was handed to the content script as a
  // literal CSS selector — under-blocking and a bogus selector at once.
  const full = buildBinary([], [PROCEDURAL, '{"selector":"#a","plan":[]}'], ['.keep']);
  const truncated = full.slice(0, full.length - 20);

  const rules = resolvePageRules({
    cosmeticRulesBinary: encodeBinaryRules(truncated),
    cosmeticRules: { generic: [], domainSpecific: ['.json-fallback'], exceptions: ['.keep'] },
  });

  assert.deepEqual(rules.domainSpecific, ['.json-fallback'], 'the JSON fallback must fire');
  assert.deepEqual(rules.exceptions, ['.keep'], 'the dropped exception must come back');
  for (const rule of rules.domainSpecific) {
    assert.ok(typeof rule !== 'string' || !rule.includes('{'), 'no half-JSON string may survive');
  }
});

test('5.8: a payload that is not this format at all decodes to null', () => {
  // A single list where three are expected: five entries consume the buffer and
  // the next count read runs off the end. This used to decode as five happy
  // generic "rules".
  const enc = new TextEncoder();
  const parts = [new Uint8Array(4)];
  new DataView(parts[0].buffer).setUint32(0, 5, true);
  for (const s of ['A', 'B', 'C', 'D', 'E']) {
    parts.push(enc.encode(s), new Uint8Array([0]));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const garbage = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { garbage.set(p, o); o += p.length; }

  assert.equal(decodeBinaryRules(garbage), null);
});

test('5.8: trailing bytes past the third list are rejected', () => {
  const full = buildBinary(['.a'], [], []);
  const withTrailer = new Uint8Array(full.length + 3);
  withTrailer.set(full);

  assert.ok(decodeBinaryRules(full));
  assert.equal(decodeBinaryRules(withTrailer), null, 'trailing bytes mean this is not our format');
});

test('5.8: an absurd entry count is rejected without iterating it', () => {
  const buffer = new Uint8Array(12);
  new DataView(buffer.buffer).setUint32(0, 0xffffffff, true);

  const started = Date.now();
  assert.equal(decodeBinaryRules(buffer), null);
  assert.ok(Date.now() - started < 1000, 'must not iterate a 4-billion entry count');
});

test('5.8: a `{`-prefixed entry that does not parse is damage, not a selector', () => {
  const bytes = buildBinary([], ['{"selector":"#a",'], []);
  assert.equal(decodeBinaryRules(bytes), null);
});

test('5.8: an empty but well-formed payload decodes to empty lists, not null', () => {
  const empty = buildBinary([], [], []);
  assert.deepEqual(decodeBinaryRules(empty), { generic: [], domainSpecific: [], exceptions: [] });
});

// --- §5.8: planVersion finally has a consumer ------------------------------

test('5.8: the JS plan version matches the one Rust stamps on every rule', () => {
  // PLAN_FORMAT_VERSION in wasm-core/src/lib.rs.
  assert.equal(PLAN_FORMAT_VERSION, 1);
});

test('5.8: a rule with an unknown planVersion is dropped, not decoded as current', () => {
  const current = `{"selector":".now","plan":[],"planVersion":${PLAN_FORMAT_VERSION}}`;
  const future = `{"selector":".later","plan":[],"planVersion":${PLAN_FORMAT_VERSION + 1}}`;
  const rules = decodeBinaryRules(buildBinary([], [current, future], []));

  assert.ok(rules, 'an unknown version is not structural damage');
  assert.equal(rules.domainSpecific.length, 1, 'only the executable rule survives');
  assert.equal(rules.domainSpecific[0].selector, '.now');
});

test('5.8: a rule written before versioning is treated as version 1', () => {
  // Rust serde defaults the missing field to PLAN_FORMAT_VERSION; the format
  // was unchanged, so legacy bundles stay fully readable.
  const rules = decodeBinaryRules(buildBinary([], [PROCEDURAL], []));
  assert.equal(rules.domainSpecific.length, 1);
  assert.equal(rules.domainSpecific[0].selector, 'div:has-text(Ad)');
});

test('5.8: the version gate also covers the JSON fallback and generic rules', () => {
  const rules = resolvePageRules({
    cosmeticRules: {
      generic: [],
      domainSpecific: [
        { selector: '.json-current', plan: [], planVersion: PLAN_FORMAT_VERSION },
        { selector: '.json-future', plan: [], planVersion: 99 },
      ],
      exceptions: [],
    },
    genericProceduralRules: [
      { selector: '.generic-future', plan: [], planVersion: 99 },
      '.plain-string-selector',
    ],
  });

  assert.deepEqual(
    rules.domainSpecific.map((r) => (typeof r === 'string' ? r : r.selector)),
    ['.plain-string-selector', '.json-current'],
  );
});
