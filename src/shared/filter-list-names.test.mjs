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

// ---------------------------------------------------------------------------
// The names themselves, pinned to the lists they name.
//
// PR #11 forgot a row; `9f42a08` then unified the two pages onto the options
// page's wording, which spread that page's errors to the popup — `annoyances`
// became "Fanboy Annoyances" (it is uAssets' own list, meant to be used
// ALONGSIDE Fanboy's) and `anti-adblock` kept "Anti-Adblock" (its source is
// badware.txt). A table of literals cannot catch that, because the literal and
// the expectation are written by the same hand. So the expectation is taken
// from the vendored snapshot's own `! Title:` header, and a second test proves
// the snapshot really is the file that list id fetches.
// ---------------------------------------------------------------------------

const repoFile = (relative) => new URL(`../../${relative}`, import.meta.url);

/** Abbreviations the display names are allowed to use, expanded before matching. */
const NAME_ABBREVIATIONS = { ubo: 'ublock' };

function significantWords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')   // also drops the ₀ in "uBlock₀"
    .split(' ')
    .filter(Boolean)
    .map((word) => NAME_ABBREVIATIONS[word] || word);
}

/** The `! Title:` header of a vendored snapshot, which is upstream's own name for it. */
function snapshotTitle(listId) {
  const text = fs.readFileSync(repoFile(`scripts/filter-lists/${listId}.txt`), 'utf8');
  const header = /^!\s*Title:\s*(.+)$/m.exec(text);
  assert.ok(header, `scripts/filter-lists/${listId}.txt has no "! Title:" header to check against`);
  return header[1].trim();
}

/** id → url, from the two places that independently record it. */
function sourceUrlsById() {
  const swSource = fs.readFileSync(repoFile('src/background/service-worker.js'), 'utf8');
  const block = /const REMOTE_FILTER_LISTS = \[([\s\S]*?)\n\];/.exec(swSource);
  assert.ok(block, 'REMOTE_FILTER_LISTS not found in service-worker.js');
  const worker = new Map(
    [...block[1].matchAll(/\{\s*id:\s*'([\w-]+)',\s*url:\s*'([^']+)'\s*\}/g)]
      .map((m) => [m[1], m[2]]));
  assert.ok(worker.size > 0, 'REMOTE_FILTER_LISTS parsed to nothing');

  const lock = JSON.parse(fs.readFileSync(repoFile('scripts/filter-lists.lock.json'), 'utf8'));
  return { worker, lock };
}

// GitHub serves the same file under both spellings; the lock records the
// redirected form it actually fetched.
const canonicalUrl = (url) => url.replace('/refs/heads/', '/');

test('5.17: every display name is drawn from its snapshot\'s "! Title:" header', () => {
  const ids = Object.keys(FILTER_LIST_NAMES);
  assert.ok(ids.length > 0, 'the name table is empty');

  for (const id of ids) {
    const title = snapshotTitle(id);
    const titleWords = significantWords(title);
    // A name word matches a title word if either is a prefix of the other, so
    // "Risks"/"risks" and "URLs"/"URL" agree without a stemmer.
    for (const word of significantWords(FILTER_LIST_NAMES[id])) {
      assert.ok(
        titleWords.some((t) => t.startsWith(word) || word.startsWith(t)),
        `${id}: display name "${FILTER_LIST_NAMES[id]}" says "${word}", which is nowhere in the `
        + `list's own title "${title}" — the name describes a different list`);
    }
  }
});

test('5.17: each named list\'s snapshot is the file its source URL is locked to', () => {
  const { worker, lock } = sourceUrlsById();

  for (const id of Object.keys(FILTER_LIST_NAMES)) {
    const workerUrl = worker.get(id);
    assert.ok(workerUrl, `${id} has a display name but no entry in REMOTE_FILTER_LISTS`);
    assert.ok(lock[id]?.url, `${id} is not in scripts/filter-lists.lock.json`);
    assert.equal(
      canonicalUrl(lock[id].url), canonicalUrl(workerUrl),
      `${id}: the worker fetches a different URL from the one the snapshot is locked to, so the `
      + 'title the name is checked against describes the wrong list');
    assert.ok(
      fs.existsSync(repoFile(`scripts/filter-lists/${id}.txt`)),
      `${id} has no vendored snapshot at scripts/filter-lists/${id}.txt`);
  }
});
