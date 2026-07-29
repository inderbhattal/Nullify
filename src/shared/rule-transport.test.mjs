import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeBinaryRules,
  decodeBinaryPayload,
  decodeBinaryRules,
  resolvePageRules,
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
