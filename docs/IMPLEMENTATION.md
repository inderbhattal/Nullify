# Nullify — Implementation Plan (Regression-Minimizing)

Companion to `docs/REVIEW.md`. The review enumerates *what* needs fixing. This document specifies *how to land the fixes without re-breaking what works*.

> **Why this exists:** the last YouTube outage (commit `f9b4f39`) was the *third* fix to YouTube shield registration in two months (`3a35970`, `b327340`, `f9b4f39`). Each fix was correct in isolation and each one introduced a follow-up regression. The same pattern shows up in service-worker startup (`3e6b424`, `2001905`, `99957c9`) and in cosmetic filtering (`9447103`). The codebase has a **regression treadmill** in three high-blast-radius modules. This plan is structured to break that pattern.

---

## 1. The Regression Treadmill — Why YouTube Keeps Breaking

Reconstructed from `git log` and the code at HEAD:

| Commit | Fix | Regression it created |
|---|---|---|
| `b327340` | Made YouTube injection allowlist-aware | First-load tabs got registered too late; ads showed for one navigation |
| `3a35970` | Optimized YT shield path; added `excludeMatches` for allowlisted hosts | Registration *config* updated, but already-open YT tabs kept the stale registration → user toggling allowlist had no effect until tab refresh |
| (unknown) | Added `AbortController` to cancel in-flight registration | Two allowlist mutations close together caused the second to abort the first; final state could be the *intermediate* one rather than the latest |
| `f9b4f39` | Replaced abort with sequential promise chain + `injectYouTubeShieldIntoOpenTabs()` for live tabs; added `persistAcrossSessions` to equality check | (current state — not yet observed in production) |

**Common failure mode:** changes to `syncYouTubeShieldRegistration` are tested by reloading the extension in dev (which always re-registers from scratch). The bug only manifests when the registration *already exists* in a prior state and a *delta* is applied. There is no automated test that exercises the "existing registration + new allowlist mutation + open YT tab" path.

**Implication for the plan:** every item in `REVIEW.md` that touches the service worker's startup path, dynamic-rule swap, YouTube shield, or cosmetic engine boot is in this same blast radius. Without harness coverage, each fix has a meaningful chance of introducing the next outage.

---

## 2. Three Hard Rules

Adopt before any P0/P1 work begins. These are non-negotiable for the modules in §3.

### Rule 1 — Test before refactor.
No PR that modifies any file in the **High-Blast-Radius set** (§3) merges without:
- A regression test (or, if Chrome internals make automation impossible, a documented manual smoke test that becomes part of release checklist) that fails on the *prior* code and passes on the new code.
- A second test that asserts the *prior correct behavior* still works (the "didn't re-break X" test).

### Rule 2 — Feature-flag risky behavior changes.
Anything that changes *when* or *how often* a side-effecting Chrome API is called (`updateDynamicRules`, `registerContentScripts`, `executeScript`, `updateContentScripts`) ships behind a runtime flag readable from `chrome.storage.local`. Default OFF for one release, default ON the next. This gives a one-line revert path that doesn't require shipping a new version.

### Rule 3 — Single PR = single concern.
The `f9b4f39` PR changed YouTube shield registration *and* 14 scriptlets *and* the build script *and* the manifest version. When something broke after deploy, bisecting was painful. Each item in this plan ships as its own PR. Bundling is forbidden except for trivial dependents.

---

## 3. Blast Radius Map

Files are sorted by *churn × user-visible impact*. Anything in **High** triggers Rule 1 + Rule 2.

### High-Blast-Radius set
- `src/background/service-worker.js` (startup, DNR swap, message routing, YT shield sync)
- `src/content/youtube-shield.js`
- `src/content/cosmetic-engine.js` (procedural pipeline, observer)
- `wasm-core/src/lib.rs` (cosmetic plan format, allowlist matcher, URL sanitiser)
- `manifest.json` (permissions + WAR + ruleset list)

### Medium
- `src/content/content-main.js`
- `src/shared/db.js`, `src/shared/storage.js`, `src/shared/hostname.js`
- `scripts/build-rules.mjs` (rule generation correctness)

### Low
- `src/popup/*`, `src/options/*` (UI; isolated from network/cosmetic correctness)
- `src/shared/wasm-loader.js`, `src/shared/psl.js`
- `src/scriptlets/*` (per-scriptlet; safe to revert one at a time)
- All other docs/scripts

---

## 4. Test Harness — Build This First (Sprint 0)

Until this exists, every other sprint is gambling. Estimate: **3–5 days of work**. Do not skip.

### 4.1 Unit-test surface (Node, fast)
Already present: `scripts/build-rules.test.mjs` (rule parser only).
Add:
- `src/shared/hostname.test.mjs` — round-trip allowlist normalization, PSL edge cases (`xn--`, `co.uk`, single-label, IDN).
- `src/shared/core-filter-source.test.mjs` — generic-hide exclusion logic.
- `scripts/build-rules.test.mjs` — extend with one fixture per modifier (`$denyallow`, `$badfilter`, `$header=`, `$csp`) so adding parser support in §6 is a strictly additive diff.
- `wasm-core` Rust tests (`cargo test`) for: allowlist matcher boolean truth table; procedural plan JSON shape; bloom filter false-positive rate at known load.

Wire into CI: `npm test` runs Node tests; `cargo test --manifest-path wasm-core/Cargo.toml` runs Rust tests. Add `test` job to `.github/workflows/build.yml`.

### 4.2 Service-worker harness (jsdom + chrome-stub)
The service worker is currently untestable because it imports `chrome.*` everywhere. To break the treadmill:
1. Create `tests/sw-harness/chrome-stub.mjs` — minimal in-memory implementations of `chrome.declarativeNetRequest`, `chrome.scripting`, `chrome.storage`, `chrome.runtime`, `chrome.tabs`, `chrome.webNavigation`, `chrome.alarms`. Each module records calls into an event log.
2. Refactor the service worker to take its `chrome` global via dependency injection — currently it's `globalThis.chrome`. One-line change at the top of `service-worker.js`: `const chromeApi = globalThis.chrome ?? globalThis.__chromeStub`. Use `chromeApi.*` everywhere new code is written; existing `chrome.*` references stay untouched (incremental migration).
3. Write the test that *would have caught* the YouTube outage:

```js
// tests/sw-harness/youtube-shield-sync.test.mjs
test('updates excludeMatches on already-registered shield when allowlist changes', async () => {
  const stub = makeChromeStub();
  globalThis.__chromeStub = stub;
  await import('../../src/background/service-worker.js');

  // Simulate prior state: shield registered, allowlist empty, YT tab open.
  stub.scripting.registeredScripts.set(YT_SCRIPT_ID, { excludeMatches: [] });
  stub.tabs.query.mockReturnValue([{ id: 1, url: 'https://www.youtube.com/' }]);

  // User adds youtube.com to allowlist.
  await stub.runtime.sendMessage({ type: 'SET_ALLOWLIST', payload: { allowlist: ['youtube.com'] } });

  const updated = stub.scripting.registeredScripts.get(YT_SCRIPT_ID);
  assert.deepEqual(updated.excludeMatches, ['*://*.youtube.com/*']);
  assert.equal(stub.scripting.executeScript.callCount, 0,
    'should not re-inject — existing tab is now allowlisted');
});

test('injects shield into already-open tabs when allowlist removes a hostname', async () => {
  // Inverse of the above; covers the bug that f9b4f39 fixed.
});
```

### 4.3 End-to-end smoke (Chrome via Puppeteer)
- `tests/e2e/youtube-smoke.mjs`: launch Chrome with the unpacked extension, navigate to a stable test page that simulates YT's ad-bearing player_response JSON (don't hit live YouTube — too flaky), assert that injected fixtures don't render and that the shield's stat counter increments.
- `tests/e2e/gmail-smoke.mjs`: load a fixture page that mimics Gmail's `.nH.PS` selector pattern, assert that allowlist exception kicks in (this was the `9447103` regression).
- `tests/e2e/allowlist-toggle.mjs`: load a page, click the popup's "allow on this site" button, assert badge updates and previously-blocked items unblock without page reload.

These run on a `pull_request` trigger, not on every push, because they're slower. ~2 minutes each.

### 4.4 Manual release-gate checklist
Some user journeys cannot be automated reliably (live YouTube, banking sites, sites with anti-adblock). Codify them in `docs/RELEASE_CHECKLIST.md`:

- [ ] Fresh install on Chrome stable; load 5 reference sites (cnn.com, nytimes.com, twitch.tv, youtube.com, gmail.com); compare against a screenshot baseline in `docs/baselines/`.
- [ ] Toggle allowlist on each, reload, verify ads return.
- [ ] Toggle allowlist off, *do not reload*, verify ads disappear within 2s (regression check for `b327340`/`3a35970` class of bugs).
- [ ] Open chrome://extensions Service Worker inspector, verify zero errors over 5 minutes of browsing.
- [ ] Open Options → Live Logger; verify events stream.
- [ ] Run extension in incognito (separate storage); verify it boots cleanly.

Release is gated on a signed-off copy of this checklist.

---

## 5. Sequencing — Sprint by Sprint

The review's original sprint ordering was P0→P2 by *severity*. That ordering ignores **blast radius and dependency**. Re-sequenced below to land the safest items first, build confidence in the new harness, and front-load items that have natural test isolation.

### Sprint 0 — Harness & Hygiene (1 week)
*Pure additive. No production behavior changes. Must land before anything else.*

| Step | From REVIEW.md | Why early |
|---|---|---|
| 0.1 | §4 of this doc | Without it, every later sprint is blind |
| 0.2 | 6.1 (scriptlet errors → logger) | Adds *visibility*, not behavior |
| 0.3 | 6.2 (`contextMenus.removeAll` lastError) | One-line, no behavior change in happy path |
| 0.4 | 6.3 (validate `RULESET_ENABLE_PRIORITY` against manifest) | Throws on misconfig at boot — fails *loud* in dev |
| 0.5 | 4.3 (build-time DNR rule budget assertion) | Pure build script, can't break runtime |
| 0.6 | Add release checklist (§4.4) | Process change, no code |

**Exit criteria:** `npm test` runs unit + SW-harness tests in CI; the YouTube regression test from §4.2 fails on a synthetically-broken service worker.

### Sprint 1 — UI & Build (1 week)
*Lowest blast radius. Tests the harness without putting users at risk.*

| Step | From REVIEW.md |
|---|---|
| 1.1 | 7.1 (i18n scaffold, English-only first; pure refactor of strings) |
| 1.2 | 7.2 (a11y: ARIA + focus + redundant icons) |
| 1.3 | 7.3 (persona delta vs full settings: SW accepts only deltas with version stamp) |
| 1.4 | 8.1 (filter-source lockfile) |
| 1.5 | 8.4 (CI lint + test gate enforced) |
| 1.6 | 10.1 (drop unused `privacy` permission — gives a one-PR observability test that "manifest change reaches users") |

**Exit criteria:** popup + options have no `chrome.i18n` regressions; lockfile-pinned filter URLs build identically twice in a row.

### Sprint 2 — Storage & DB (1 week)
*Medium blast radius; isolated from network/cosmetic correctness.*

| Step | From REVIEW.md |
|---|---|
| 2.1 | 5.1 (quota handling + LRU eviction) |
| 2.2 | 5.2 (single-transaction reads in `db.js`) |
| 2.3 | 3.3 (stats persistence: `chrome.storage.session` for in-flight; flush on `onSuspend`) |
| 2.4 | 6.4 (centralised user-filter size cap) |
| 2.5 | 6.5 (cosmetic-rule dedup on user merge) |

**Exit criteria:** stats survive an SW restart in the harness; quota-exhaustion path is exercised by a fault-injection test.

### Sprint 3 — Filter Parser (Build-Time Only) (1.5 weeks)
*Build script changes only. No runtime behavior change until the rules ship.*

Every parser change ships in two PRs:
1. **Add fixtures** — sample upstream rules using the modifier; assert current behavior (drop / mis-parse). Lands red.
2. **Implement parser** — turns the fixtures green.

| Step | From REVIEW.md |
|---|---|
| 3.1 | 4.1a `$badfilter` (must come first — it suppresses prior rules) |
| 3.2 | 4.1b `$denyallow` |
| 3.3 | 4.1c `$header=` |
| 3.4 | 4.2 `$csp` via `modifyHeaders` |
| 3.5 | 4.5 redirect resource library (vendor uBO resources; map redirect tokens) |
| 3.6 | 4.4 raise regex cap to 256 + log to `rules/skipped/` |

**Exit criteria:** rebuild produces strictly more enabled rules than HEAD, with zero rule-count regressions; manual diff of one ruleset shows the new modifiers in action.

### Sprint 4 — Service-Worker Lifecycle (1.5 weeks; THE HIGH-RISK SPRINT)
*All in the High-Blast-Radius set. Each item is feature-flagged per Rule 2.*

This is the sprint most likely to break YouTube. Each step ships behind a flag (`features.lifecycle_v2`) defaulting OFF, then defaulting ON in the *next* version after a soak.

Order matters — earlier items are dependencies of later ones:

| Step | From REVIEW.md | Flag | Notes |
|---|---|---|---|
| 4.1 | 3.2 (`wasmReady` → `await waitForWasm()` in async paths) | `features.lifecycle_v2.wasm_gate` | Pure read-side change; no Chrome-API call shape change |
| 4.2 | 3.1 (`webNavigation` listeners await setup) | same | Most likely to surface latent races; soak 1 release |
| 4.3 | 2.4 (refuse user-filter compile until WASM ready) | same | Builds on 4.1 |
| 4.4 | 2.5 (atomic dynamic rule swap with pending marker) | `features.lifecycle_v2.atomic_dnr` | Touches `updateDynamicRules`. **Highest risk.** Land alone, soak 1 release before the next item |
| 4.5 | 3.5 (cosmetic in-flight cache: separate compute from persist) | same | Builds on 4.4 |
| 4.6 | 3.4 (YT shield re-registration: cancel via AbortController + re-read latest snapshot inside promise) | `features.lifecycle_v2.yt_shield_v3` | **The exact code path that has broken three times.** Required tests from §4.2 must be green; manual test: open YT in two tabs, toggle allowlist on first tab, verify second tab updates without reload |

**Exit criteria for the sprint:** all six items default ON in production for ≥7 days with no spike in error reports.

### Sprint 5 — Security & Privilege (1 week)
*Lower runtime blast radius (changes refusal paths), but high *user trust* impact — a bug here can wipe allowlists.*

| Step | From REVIEW.md |
|---|---|
| 5.1 | 2.6 (filter-list fetch timeout + size cap) |
| 5.2 | 2.4 already in Sprint 4 — leave |
| 5.3 | 2.3 (privileged-message gate on `FORCE_CLEAN_ALL_DYNAMIC_RULES` and friends) |
| 5.4 | 2.1 (runtime SRI: emit `dist/integrity.json` at CI; verify on boot; UI surface) |
| 5.5 | 2.2 (narrow WAR `matches` to specific origins) |
| 5.6 | 9.1, 9.2 (audit Rust `.unwrap()`, allocator caps) |
| 5.7 | 9.3 (versioned procedural-plan schema) |

**Exit criteria:** install-time integrity check fails on a deliberately-tampered ruleset; FORCE_CLEAN can no longer be invoked from a popup-impersonating message.

### Sprint 6 — Parity & Polish (1 week)
*Low blast radius. Saves the dessert for last.*

| Step | From REVIEW.md |
|---|---|
| 6.1 | 4.6 implement or remove `:if`/`:if-not` |
| 6.2 | 4.7 fix `:semantic()` async race |
| 6.3 | 5.3 `chrome.storage.sync` allowlist mirror (opt-in) |
| 6.4 | 11 context-menu "block element" |
| 6.5 | 8.2 signed releases |
| 6.6 | 8.3 reproducible build assertion |

---

## 6. PR Template (Adopt for Every Change)

To make Rules 1–3 mechanically enforceable, add `.github/pull_request_template.md`:

```markdown
## What & Why
<one paragraph>

## Blast radius
- [ ] Low (popup/options/scriptlet/build script)
- [ ] Medium (shared/, content-main, db)
- [ ] **High** (service-worker, youtube-shield, cosmetic-engine, wasm-core/lib.rs, manifest)

## Tests
- [ ] New regression test added (link line)
- [ ] Existing tests cover this change because: <reason>
- [ ] N/A (docs/CI-only)

## Manual verification
- [ ] Steps to reproduce documented above
- [ ] Checked YouTube (golden path) ✅
- [ ] Checked Gmail (cosmetic golden path) ✅
- [ ] No new SW errors in chrome://extensions inspector

## Rollback
- Feature flag: `features.<...>` (set to false to revert)
- OR: this PR is revert-clean (no DB migrations, no manifest version bump that requires re-grant)

## Single concern
- [ ] This PR addresses one item in IMPLEMENTATION.md
```

PRs failing the template's High-blast-radius gate cannot merge without two reviewers + a green E2E run.

---

## 7. The "Don't Rebreak YouTube" Bullseye Tests

These are the smallest set of tests that, if always green, would have prevented every YouTube regression to date. They live in `tests/regression/youtube/` and run on every PR touching the High-Blast-Radius set.

1. **Cold install on YT tab** — fresh extension, navigate to YT, ad fixtures suppressed within 1.5s.
2. **Allowlist add on open YT tab** — YT open, then user allowlists `youtube.com`, ads return without page reload.
3. **Allowlist remove on open allowlisted YT tab** — inverse; ads disappear without reload.
4. **Two YT tabs, allowlist toggle on first** — second tab unaffected initially; updates only when its own state changes (verifies per-tab targeting).
5. **Music subdomain isolation** — allowlist `music.youtube.com`; verify `www.youtube.com` still blocked.
6. **SW restart preserves shield** — kill the SW, navigate to YT, verify shield re-registers within 500ms of the new tab opening.
7. **Upgrade-in-place** — install `v(N-1)`, browse YT, upgrade to `v(N)` via "reload extension", verify YT continues blocking with no manual refresh.

Test #6 and #7 are the ones that catch the registration-state-mutation class of bugs that have hit three times.

---

## 8. Anti-Goals (Things to Avoid)

- **Do not refactor `service-worker.js` into multiple files in this plan cycle.** It's tempting; it's also a change that touches every line of the riskiest file. If a split is desired, it gets its own dedicated cycle *after* this plan completes and the regression suite is mature.
- **Do not change DNR ruleset IDs or the manifest's `rule_resources` array order** — Chrome treats this as a fresh ruleset registration; users lose dynamic-rule state. If a re-shuffle is needed, do it in a single dedicated release with migration code.
- **Do not bundle scriptlet rewrites with non-scriptlet changes** — `f9b4f39` mixed 14 scriptlet edits with the YT shield fix; bisecting a regression to "is it the scriptlet or the shield?" cost time.
- **Do not skip the soak window between feature-flag default-OFF and default-ON.** One full release cycle minimum.

---

## 9. Effort Estimate

| Sprint | Eng-weeks | Risk |
|---|---|---|
| 0 — Harness | 1 | low |
| 1 — UI/Build | 1 | low |
| 2 — Storage | 1 | low–medium |
| 3 — Parser | 1.5 | low (build-time only) |
| 4 — SW Lifecycle | 1.5 | **high** |
| 5 — Security | 1 | medium |
| 6 — Parity/Polish | 1 | low |
| **Total** | **8 weeks** | |

If staffed at 1 engineer, ~2 calendar months. With the Sprint 4 soak window between items 4.4 and 4.6, real-world calendar time is ~10–11 weeks.

---

## 10. Definition of Done

- All P0 items in `REVIEW.md` shipped and default-on.
- All P1 items shipped (storage sync may remain opt-in).
- Regression suite (§4) covers every High-Blast-Radius file.
- Release checklist (§4.4) signed for the most recent release.
- No YouTube-related issue filed in the 30 days following the Sprint 4 default-ON flip.
- `docs/REVIEW.md` re-read with a fresh eye; remaining gaps filed as new issues for the next cycle.
