/**
 * Regression tests for the options-page status formatters (§5.32, §5.3).
 *
 * The service worker has always returned `skippedNetwork`/`skippedRules` and
 * `rejected`; §5.32 found nothing read them, so 30 refused filter lines still
 * rendered as "✓ Applied N network and M cosmetic rules". These tests pin the
 * two properties that finding is about: a refusal is never reported as an
 * unqualified success, and the per-item reasons survive into the detail list.
 *
 * The formatters are DOM-free by design (`showStatus` owns the rendering), so
 * they need no chrome stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  FILTERS_NOT_LOADED_MESSAGE,
  STORAGE_READ_FAULT_CODE,
  STORAGE_READ_FAULT_MESSAGE,
  describeAllowlistImport,
  describeFilterApply,
  describeFilterImport,
  describeRejectedDomains,
  describeSkippedRules,
  describeUpdateResult,
  describeWriteFailure,
  filtersEditorState,
  isStorageReadFault,
  skippedSuffix,
} = await import('./status-format.js');

// ---------------------------------------------------------------------------
// §5.32 — user-filter skips
// ---------------------------------------------------------------------------

test('a clean apply reads exactly as before, with no skip clause', () => {
  const out = describeFilterApply({ network: 12, cosmetic: 3, skippedNetwork: 0, skippedRules: [] });
  assert.equal(out.message, '✓ Applied 12 network and 3 cosmetic rules');
  assert.equal(out.type, 'success');
  assert.deepEqual(out.detail, []);
  assert.equal(out.skipped, 0);
});

test('skipped rules are stated in the message, not hidden behind a checkmark', () => {
  const out = describeFilterApply({
    network: 4,
    cosmetic: 1,
    skippedNetwork: 30,
    skippedRules: [{ id: 900001, reason: 'regex is not supported' }],
  });
  assert.match(out.message, /30 network rules skipped/);
  assert.ok(!out.message.startsWith('✓'), 'a partial apply must not claim unqualified success');
  assert.equal(out.type, 'warning');
  assert.equal(out.skipped, 30);
});

test('per-rule reasons reach the detail list, and the SW cap of 20 is stated', () => {
  const skippedRules = Array.from({ length: 20 }, (_, i) => ({ id: 900000 + i, reason: 'RE2 syntax error' }));
  const detail = describeSkippedRules({ skippedNetwork: 30, skippedRules });
  assert.equal(detail.length, 21);
  assert.equal(detail[0], 'Rule #900000: RE2 syntax error');
  assert.match(detail[20], /10 more skipped rules/);
});

test('describeSkippedRules survives missing ids, reasons and arrays', () => {
  assert.deepEqual(describeSkippedRules(undefined), []);
  assert.deepEqual(describeSkippedRules({ skippedNetwork: 0, skippedRules: null }), []);
  assert.deepEqual(
    describeSkippedRules({ skippedNetwork: 1, skippedRules: [{}] }),
    ['Rule #?: rejected by Chrome'],
  );
  // A count with no per-rule detail still tells the user the size of the loss.
  assert.deepEqual(describeSkippedRules({ skippedNetwork: 3, skippedRules: [] }), [
    '…and 3 more skipped rules not listed',
  ]);
});

test('3.3: a dropped line renders its text, not #null', () => {
  // A2's §3.3 surface: the Rust user-filter compiler now fails closed and the
  // SW reports each dropped line as `{id: null, reason, line}` — there is no
  // DNR id because the line never became a rule. Name the line, not "#null".
  const detail = describeSkippedRules({
    skippedNetwork: 1,
    skippedRules: [{ id: null, reason: 'unsupported option: removeparam', line: '||x^$removeparam=a' }],
  });
  assert.deepEqual(detail, ['"||x^$removeparam=a": unsupported option: removeparam']);
  assert.ok(!detail[0].includes('#null'), 'a dropped line must not render as "Rule #null"');
  assert.ok(!detail[0].includes('#?'), 'a dropped line must not render as "Rule #?"');

  // Didn't re-break: a Chrome-rejected rule with a numeric id keeps its wording.
  assert.deepEqual(
    describeSkippedRules({ skippedNetwork: 1, skippedRules: [{ id: 12, reason: 'regex is not supported' }] }),
    ['Rule #12: regex is not supported'],
  );

  // A null id with no line to show falls back to just the reason — never "#null".
  const bare = describeSkippedRules({ skippedNetwork: 1, skippedRules: [{ id: null, reason: 'unsupported option: removeparam' }] });
  assert.deepEqual(bare, ['unsupported option: removeparam']);
  assert.ok(!bare[0].includes('null'));

  // The line text is passed through verbatim; the caller renders it with
  // textContent, so the formatter must not escape or truncate it.
  const raw = describeSkippedRules({
    skippedNetwork: 1,
    skippedRules: [{ id: null, reason: 'bad', line: '<script>"a&b"</script>' }],
  });
  assert.deepEqual(raw, ['"<script>"a&b"</script>": bad']);
});

test('the DNR-budget warning still shows, and carries the skip clause too', () => {
  const out = describeFilterApply({
    network: 6000,
    cosmetic: 0,
    warning: 'Network rule count 6000 exceeds budget 5000',
    skippedNetwork: 2,
    skippedRules: [{ id: 1, reason: 'too many rules' }],
  });
  assert.match(out.message, /^⚠ Network rule count 6000 exceeds budget 5000/);
  assert.match(out.message, /2 network rules skipped/);
  assert.equal(out.type, 'warning');
  // One listed reason plus the overflow line for the skip the SW did not detail.
  assert.deepEqual(out.detail, ['Rule #1: too many rules', '…and 1 more skipped rule not listed']);
});

test('a response with no counts (older SW shape) still reports success', () => {
  const out = describeFilterApply(undefined);
  assert.equal(out.message, '✓ Filters applied successfully');
  assert.equal(out.type, 'success');
  assert.equal(out.skipped, 0);
});

test('a filter import carries the apply outcome instead of overwriting it', () => {
  // The import status replaces the save status, so a skip or a budget warning
  // raised by the apply must survive into it (§5.32).
  const applied = describeFilterApply({
    network: 4,
    cosmetic: 1,
    skippedNetwork: 30,
    skippedRules: [{ id: 900001, reason: 'regex is not supported' }],
  });
  const out = describeFilterImport('list.txt', 50, applied);
  assert.equal(
    out.message,
    '⚠ Imported list.txt (50 rules added) — Applied 4 network and 1 cosmetic rules — 30 network rules skipped',
  );
  assert.equal(out.type, 'warning');
  assert.equal(out.detail, applied.detail);
});

test('a filter import with a clean apply keeps the plain success wording', () => {
  const applied = describeFilterApply({ network: 4, cosmetic: 1, skippedNetwork: 0, skippedRules: [] });
  const out = describeFilterImport('list.txt', 1, applied);
  assert.equal(out.message, '✓ Imported list.txt (1 rule added)');
  assert.equal(out.type, 'success');
  assert.deepEqual(out.detail, []);
});

test('a filter import carries a DNR-budget warning through as well', () => {
  const applied = describeFilterApply({ network: 6000, warning: 'Network rule count 6000 exceeds budget 5000' });
  const out = describeFilterImport('list.txt', 6000, applied);
  assert.match(out.message, /^⚠ Imported list\.txt \(6000 rules added\) — Network rule count 6000 exceeds budget 5000$/);
});

test('skippedSuffix is singular at 1, empty at 0, and ignores junk', () => {
  assert.equal(skippedSuffix(0), '');
  assert.equal(skippedSuffix(1), ' — 1 network rule skipped');
  assert.equal(skippedSuffix(2), ' — 2 network rules skipped');
  assert.equal(skippedSuffix(undefined), '');
  assert.equal(skippedSuffix(NaN), '');
  assert.equal(skippedSuffix(-5), '');
});

// ---------------------------------------------------------------------------
// §5.32 — rejected allowlist entries
// ---------------------------------------------------------------------------

test('rejected allowlist entries are counted and named', () => {
  const { count, detail } = describeRejectedDomains(['co.uk', 'com']);
  assert.equal(count, 2);
  assert.match(detail[0], /^co\.uk — not a valid allowlist domain/);
  assert.match(detail[1], /^com — /);
});

test('describeRejectedDomains ignores absent, empty and non-string entries', () => {
  assert.deepEqual(describeRejectedDomains(undefined), { count: 0, detail: [] });
  assert.deepEqual(describeRejectedDomains('co.uk'), { count: 0, detail: [] });
  assert.equal(describeRejectedDomains(['', '  ', null, 42, 'co.uk']).count, 1);
});

test('an import with rejections does not render as an unqualified success', () => {
  const out = describeAllowlistImport('list.txt', 5, ['co.uk']);
  assert.equal(out.message, '⚠ Imported list.txt (5 sites added, 1 entry rejected)');
  assert.equal(out.type, 'warning');
  assert.equal(out.detail.length, 1);
});

test('an import with no rejections keeps the original success wording', () => {
  const out = describeAllowlistImport('list.txt', 3, []);
  assert.equal(out.message, '✓ Imported list.txt (3 sites added)');
  assert.equal(out.type, 'success');
});

test('zero added and zero rejected is still "nothing to import"', () => {
  const out = describeAllowlistImport('list.txt', 0, []);
  assert.equal(out.message, 'No new sites to import');
  assert.equal(out.type, 'warning');
});

test('zero added but some rejected reports the rejection rather than "nothing to import"', () => {
  const out = describeAllowlistImport('list.txt', 0, ['co.uk', 'org']);
  assert.equal(out.message, '⚠ Imported list.txt (0 sites added, 2 entries rejected)');
  assert.equal(out.detail.length, 2);
});

// ---------------------------------------------------------------------------
// §5.3 — CHECK_FILTER_UPDATES response, new and old shapes
// ---------------------------------------------------------------------------

test('the new shape names the lists that actually updated', () => {
  const out = describeUpdateResult(
    { ok: true, updatedLists: ['easylist', 'easyprivacy'] },
    (id) => ({ easylist: 'EasyList', easyprivacy: 'EasyPrivacy' })[id],
  );
  assert.equal(out.message, '✓ Updated 2 filter lists: EasyList, EasyPrivacy');
  assert.equal(out.type, 'success');
});

test('an empty updatedLists is reported as "nothing updated", not success', () => {
  const out = describeUpdateResult({ ok: true, updatedLists: [] });
  assert.equal(out.type, 'warning');
  assert.match(out.message, /No filter lists were updated/);
});

test('the OLD bare {ok:true} shape is tolerated so the halves can land apart', () => {
  const out = describeUpdateResult({ ok: true });
  assert.equal(out.message, '✓ Update check complete');
  assert.equal(out.type, 'success');
  assert.deepEqual(out.detail, []);
  // Same tolerance for a response the wrapper resolved to something odd.
  assert.equal(describeUpdateResult(undefined).type, 'success');
});

test('updatedLists entries may be ids or {id,name} objects; junk is dropped', () => {
  const out = describeUpdateResult(
    { ok: true, updatedLists: [{ id: 'malware' }, { name: 'uBO Filters' }, null, '', 7] },
    (id) => (id === 'malware' ? 'Malware Blocklist' : id),
  );
  assert.equal(out.message, '✓ Updated 2 filter lists: Malware Blocklist, uBO Filters');
});

test('an unknown list id falls back to the raw id rather than disappearing', () => {
  const out = describeUpdateResult({ ok: true, updatedLists: ['brand-new-list'] }, () => undefined);
  assert.match(out.message, /brand-new-list/);
});

// ---------------------------------------------------------------------------
// §4.14 / §7.4 — storage-fault replies
// ---------------------------------------------------------------------------

// The shape `call()` produces from a `{error, code}` reply once the bus
// forwards the worker's StorageReadError code.
const readFault = () => Object.assign(new Error('An unexpected error occurred'), { code: 'READ_FAILED' });

test('4.14: an identified read fault renders the "nothing was changed" line', () => {
  assert.equal(STORAGE_READ_FAULT_CODE, 'READ_FAILED', 'the code src/shared/storage.js puts on StorageReadError');
  assert.equal(isStorageReadFault(readFault()), true);

  const out = describeWriteFailure(readFault(), '✗ Failed to save setting: An unexpected error occurred');
  assert.equal(out.message, `✗ ${STORAGE_READ_FAULT_MESSAGE}`);
  assert.equal(out.message, '✗ Could not read saved settings — nothing was changed; try again');
  assert.equal(out.type, 'error');
});

test('4.14: any other failure keeps the caller\'s sentence — a later step can fail after the write', () => {
  // ALLOW_SITE persists before it rebuilds DNR rules; UPDATE_SETTINGS before
  // applyPrivacySettings. An {error} from those steps follows a completed
  // write, so "nothing was changed" may only be claimed for a read fault.
  const dnrFailure = new Error('Rule with id 1 does not have a unique ID');
  assert.equal(isStorageReadFault(dnrFailure), false);
  const out = describeWriteFailure(dnrFailure, '✗ Could not remove a.example: Rule with id 1 does not have a unique ID');
  assert.equal(out.message, '✗ Could not remove a.example: Rule with id 1 does not have a unique ID');
  assert.equal(out.type, 'error');

  // Chrome's raw text alone is NOT the signal: the same words can come from
  // any API, and the fallback message is what shows them.
  const rawTextOnly = new Error('An unexpected error occurred');
  assert.equal(isStorageReadFault(rawTextOnly), false);
  assert.equal(describeWriteFailure(rawTextOnly, '✗ raw').message, '✗ raw');

  // Other codes, a non-Error, and nothing at all.
  assert.equal(isStorageReadFault(Object.assign(new Error('x'), { code: 'QUOTA' })), false);
  assert.equal(isStorageReadFault('READ_FAILED'), false);
  assert.equal(isStorageReadFault(undefined), false);
  assert.equal(describeWriteFailure(undefined, '✗ fallback').message, '✗ fallback');
});

test('7.4: a failed GET_USER_FILTERS leaves the editor locked with every writer disabled', () => {
  const out = filtersEditorState({ ok: false, error: new Error('An unexpected error occurred') });
  assert.equal(out.loaded, false);
  assert.equal(out.filters, '', 'nothing may be shown as "the filters" — but it must not be saveable either');
  assert.equal(out.status.type, 'error');
  assert.equal(out.status.retry, true, 'the user must be offered a retry');
  assert.equal(out.status.message, `✗ ${FILTERS_NOT_LOADED_MESSAGE}: An unexpected error occurred`);
  assert.match(out.status.message, /disabled/, 'the status says why the editor is locked');

  // The same lock when the reply is a read fault, and when the error is opaque.
  assert.equal(filtersEditorState({ ok: false, error: readFault() }).loaded, false);
  const opaque = filtersEditorState({ ok: false, error: undefined });
  assert.equal(opaque.loaded, false);
  assert.equal(opaque.status.message, `✗ ${FILTERS_NOT_LOADED_MESSAGE}: unknown error`);
});

test('7.4: a successful load unlocks the editor with the stored text — including legitimately empty', () => {
  const out = filtersEditorState({ ok: true, filters: 'example.com##.ad\n' });
  assert.equal(out.loaded, true);
  assert.equal(out.filters, 'example.com##.ad\n');
  assert.equal(out.status, null);

  const empty = filtersEditorState({ ok: true, filters: '' });
  assert.equal(empty.loaded, true, 'a read that succeeded and found nothing is editable — that is not a fault');
  assert.equal(empty.filters, '');

  // A reply without a string `filters` (older SW, odd shape) is an empty editor, not a lock.
  const odd = filtersEditorState({ ok: true, filters: undefined });
  assert.equal(odd.loaded, true);
  assert.equal(odd.filters, '');
});
