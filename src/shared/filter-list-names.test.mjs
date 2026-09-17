/**
 * Pins the one table of filter-list display names (docs/REVIEW-2026-09.md
 * §5.17). The popup and the options page each hand-maintained a copy, and a
 * list the service worker knows but a copy lacks is simply absent from that
 * page — no chip, no toggle card, no error anywhere. The ids are checked
 * against the worker's own `ALL_KNOWN_LIST_IDS` (through the SW harness), so a
 * list added there fails here until it has a row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadServiceWorker } from '../../tests/sw-harness/sw-loader.mjs';
import { FILTER_LIST_NAMES, FILTER_LIST_DESCRIPTIONS } from './filter-list-names.js';

// Known to the worker, deliberately without a row. `system-unbreak` is the
// extension's own hand-maintained ruleset: pinned on by
// `normalizeEnabledRulesetsMap`, absent from `REMOTE_FILTER_LISTS` (so never
// refreshed or named in an update status) and without a toggle. Neither page
// has ever listed it.
const LISTS_WITHOUT_A_ROW = ['system-unbreak'];

const hasText = (value) => typeof value === 'string' && value.trim() !== '';

let knownListIdsPromise = null;
/** The worker's `ALL_KNOWN_LIST_IDS`, read once per file through the harness. */
function knownListIds() {
  knownListIdsPromise ??= (async () => {
    const { hooks } = await loadServiceWorker({ awaitReady: true });
    hooks.cancelPendingStatsPersistForTest();
    return [...hooks.ALL_KNOWN_LIST_IDS];
  })();
  return knownListIdsPromise;
}

test('5.17: every known list id has a display name', async () => {
  const listed = (await knownListIds()).filter((id) => !LISTS_WITHOUT_A_ROW.includes(id));
  // An empty id list would make the loop below pass without checking anything.
  assert.ok(listed.length > 0, 'the harness must expose the worker\'s list ids');

  for (const id of listed) {
    assert.ok(
      hasText(FILTER_LIST_NAMES[id]),
      `${id} is in the service worker's ALL_KNOWN_LIST_IDS but has no display name — add it to `
      + 'src/shared/filter-list-names.js, or it is missing from the popup and the options page');
  }
});

test('5.17: no display name exists for a list id the service worker does not know', async () => {
  const known = new Set(await knownListIds());

  for (const id of Object.keys(FILTER_LIST_NAMES)) {
    assert.ok(
      known.has(id),
      `${id} has a display name but is not in ALL_KNOWN_LIST_IDS — both pages would render a `
      + 'list that does not exist, and as active (its state is undefined, not false)');
  }
});

test('5.17: the only known list id without a row is the built-in system-unbreak', async () => {
  const known = await knownListIds();

  for (const id of LISTS_WITHOUT_A_ROW) {
    assert.ok(known.includes(id), `${id} is no longer a known list id — drop it from LISTS_WITHOUT_A_ROW`);
    assert.equal(
      FILTER_LIST_NAMES[id],
      undefined,
      `${id} cannot be disabled; a row would render a popup chip and an options-page toggle for it`);
  }
});

test('5.17: names and descriptions cover the same list ids', () => {
  assert.deepEqual(
    Object.keys(FILTER_LIST_DESCRIPTIONS).sort(),
    Object.keys(FILTER_LIST_NAMES).sort(),
    'the options page renders one card per name and reads its description from the other table');

  for (const [id, description] of Object.entries(FILTER_LIST_DESCRIPTIONS)) {
    assert.ok(hasText(description), `${id} has an empty description`);
  }
});

test('5.17: the popup and the options page import the shared table instead of carrying a copy', () => {
  const pages = {
    'src/popup/popup.js': ['FILTER_LIST_NAMES'],
    'src/options/options.js': ['FILTER_LIST_NAMES', 'FILTER_LIST_DESCRIPTIONS'],
  };
  const sharedText = [...Object.values(FILTER_LIST_NAMES), ...Object.values(FILTER_LIST_DESCRIPTIONS)];

  for (const [page, wanted] of Object.entries(pages)) {
    const source = fs.readFileSync(new URL(`../../${page}`, import.meta.url), 'utf8');

    const clause = /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/shared\/filter-list-names\.js['"]/.exec(source);
    assert.ok(clause, `${page} must import ../shared/filter-list-names.js`);
    // `X as Y` still imports X.
    const imported = clause[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]);
    for (const name of wanted) {
      assert.ok(imported.includes(name), `${page} must import ${name} from the shared table`);
    }

    // A string literal equal to a shared name or description is a second copy
    // of the table, which is how the two pages drifted apart.
    for (const text of sharedText) {
      for (const quote of ['\'', '"', '`']) {
        assert.ok(
          !source.includes(`${quote}${text}${quote}`),
          `${page} re-declares ${quote}${text}${quote} — read it from src/shared/filter-list-names.js`);
      }
    }
  }
});
