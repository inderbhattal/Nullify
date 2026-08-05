/**
 * status-format.js — pure formatters for the options page's status line.
 *
 * The service worker already reports what it refused: `SET_USER_FILTERS` /
 * `APPEND_USER_FILTER` return `{skippedNetwork, skippedRules}`, the allowlist
 * writers return `rejected`, and `CHECK_FILTER_UPDATES` reports which lists it
 * actually refreshed. §5.32 found none of it had a reader, so the UI reported
 * "✓ Applied N rules" over 30 dropped lines. These helpers turn those fields
 * into the status text and the expandable detail list `showStatus` renders.
 *
 * Everything here is DOM-free and chrome-free so it can be unit-tested
 * (`status-format.test.mjs`); the caller owns the rendering.
 */

/** Plural-safe "N thing"/"N things"; pass `plural` for irregular nouns. */
function count(n, noun, plural = `${noun}s`) {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** Coerce an untrusted numeric field to a non-negative integer. */
function toCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * ` — 3 network rules skipped`, or '' when nothing was skipped. Appended to
 * whichever sentence the caller is already showing so the skip is never
 * hidden behind a success message.
 */
export function skippedSuffix(skippedNetwork) {
  const n = toCount(skippedNetwork);
  return n === 0 ? '' : ` — ${count(n, 'network rule')} skipped`;
}

/**
 * Per-rule skip reasons as display lines. The SW caps `skippedRules` at 20
 * entries while `skippedNetwork` is the true total, so the overflow is stated
 * rather than silently dropped — the same honesty this whole finding is about.
 */
export function describeSkippedRules(counts) {
  const total = toCount(counts?.skippedNetwork);
  const entries = Array.isArray(counts?.skippedRules) ? counts.skippedRules : [];
  const lines = entries.map((entry) => {
    const id = entry?.id === undefined || entry?.id === null ? '?' : entry.id;
    const reason = entry?.reason ? String(entry.reason) : 'rejected by Chrome';
    return `Rule #${id}: ${reason}`;
  });
  if (total > lines.length) {
    lines.push(`…and ${count(total - lines.length, 'more skipped rule')} not listed`);
  }
  return lines;
}

/**
 * Turn a `SET_USER_FILTERS` response into `{message, type, detail, skipped}`.
 * `message` carries its own glyph so the caller can hand it straight to
 * `showStatus`; `skipped` lets a caller with its own sentence (the filter
 * importer) append `skippedSuffix()` instead.
 */
export function describeFilterApply(counts) {
  const skipped = toCount(counts?.skippedNetwork);
  const detail = describeSkippedRules(counts);
  const base = counts?.warning
    ? String(counts.warning)
    : Number.isFinite(counts?.network)
      ? `Applied ${counts.network} network and ${toCount(counts?.cosmetic)} cosmetic rules`
      : 'Filters applied successfully';

  const summary = base + skippedSuffix(skipped);
  const type = counts?.warning || skipped > 0 ? 'warning' : 'success';
  return { message: `${type === 'warning' ? '⚠' : '✓'} ${summary}`, summary, type, detail, skipped };
}

/**
 * Status for a filter-file import, which replaces the apply status the import
 * just triggered. Anything the apply had to report — a skip count, a DNR
 * budget warning — is carried into this message rather than being overwritten
 * by "✓ Imported N rules"; `applied` is a `describeFilterApply` descriptor.
 */
export function describeFilterImport(fileName, addedRules, applied) {
  const added = `${count(toCount(addedRules), 'rule')} added`;
  if (applied?.type === 'warning') {
    return {
      message: `⚠ Imported ${fileName} (${added}) — ${applied.summary}`,
      type: 'warning',
      detail: applied.detail || [],
    };
  }
  return { message: `✓ Imported ${fileName} (${added})`, type: 'success', detail: applied?.detail || [] };
}

/**
 * The `rejected` array from `ALLOW_SITE` / `SET_ALLOWLIST` /
 * `ADD_ALLOWLIST_DOMAINS` — entries the SW's validator refused (public
 * suffixes, bare TLDs, malformed hosts).
 */
export function describeRejectedDomains(rejected) {
  const list = (Array.isArray(rejected) ? rejected : [])
    .filter((domain) => typeof domain === 'string' && domain.trim() !== '');
  return {
    count: list.length,
    detail: list.map((domain) => `${domain} — not a valid allowlist domain (public suffix, bare TLD, or malformed)`),
  };
}

/** Status for an allowlist file import, including anything the SW refused. */
export function describeAllowlistImport(fileName, addedCount, rejected) {
  const added = toCount(addedCount);
  const { count: rejectedCount, detail } = describeRejectedDomains(rejected);

  if (added === 0 && rejectedCount === 0) {
    return { message: 'No new sites to import', type: 'warning', detail: [] };
  }
  if (rejectedCount === 0) {
    return { message: `✓ Imported ${fileName} (${count(added, 'site')} added)`, type: 'success', detail };
  }
  return {
    message: `⚠ Imported ${fileName} (${count(added, 'site')} added, ${count(rejectedCount, 'entry', 'entries')} rejected)`,
    type: 'warning',
    detail,
  };
}

/**
 * Status for a `CHECK_FILTER_UPDATES` response (§5.3).
 *
 * Total failure never reaches here — `call()` rejects on `{ok:false}`/`{error}`
 * and the caller reports that. This handles the success shapes, and tolerates
 * both of them so the SW-side and UI-side halves can land independently:
 *   - new: `{ok:true, updatedLists:[…]}` — name the lists that refreshed, and
 *     say so plainly when the array is empty (nothing was actually fetched).
 *   - old: `{ok:true}` with no `updatedLists` — report completion without
 *     claiming to know which lists changed.
 *
 * `nameFor` maps a list id to its display name; entries may be plain ids or
 * `{id, name}` objects.
 */
export function describeUpdateResult(response, nameFor = (id) => id) {
  const raw = response?.updatedLists;
  if (!Array.isArray(raw)) {
    return { message: '✓ Update check complete', type: 'success', detail: [] };
  }

  const names = raw
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? entry?.name))
    .filter((id) => typeof id === 'string' && id.trim() !== '')
    .map((id) => nameFor(id) || id);

  if (names.length === 0) {
    return { message: '⚠ No filter lists were updated', type: 'warning', detail: [] };
  }
  return {
    message: `✓ Updated ${count(names.length, 'filter list')}: ${names.join(', ')}`,
    type: 'success',
    detail: [],
  };
}
