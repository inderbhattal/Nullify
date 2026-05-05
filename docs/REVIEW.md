# Nullify — Senior Staff Engineering Review & Remediation Plan

**Reviewer scope:** Architecture, security, MV3 correctness, feature parity, supply chain, build, UI.
**Codebase snapshot:** `main` @ 4.0.0 (~12.5k LOC, MV3, JS + Rust/WASM core).
**Date:** 2026-05-05.

This document is a prioritized punch-list of holes found in the implementation and design, written so each item can be filed as its own issue/PR. Items are tagged **P0** (ship-blocker / data-loss / security-relevant), **P1** (correctness / parity), **P2** (hardening / polish).

---

## 1. Executive Summary

Nullify is a competently-built MV3 ad-blocker with a Rust/WASM core, a uBO-style content-side cosmetic engine, and a DNR-driven network layer. The architecture is sound and there are no exploitable RCE/XSS vectors in the user-facing UI. The principal risks are concentrated in three areas:

1. **Supply chain & integrity** — filter lists are SRI-verified at build time but not at runtime; the WASM blob is web-accessible without integrity binding; bundled rule JSON has no signature.
2. **MV3 lifecycle correctness** — startup race conditions where `wasmReady` and DNR rebuild can lose to early `webNavigation` events; non-atomic dynamic-rule swaps; YouTube shield re-registration debounce gap.
3. **Filter-syntax parity gaps** — missing `$denyallow`, `$badfilter`, `$header=`, `$csp` (intentionally skipped), generic redirect resources, and DNR rule-budget validation.

The UI layer is in good shape — `sender.id === chrome.runtime.id` is enforced (`src/background/service-worker.js:2704`), allowlist input is normalised through `URL`/PSL not regex (`src/shared/hostname.js:15-51`), no telemetry, no XSS. The biggest UI gaps are i18n (no `_locales/`) and accessibility (no ARIA, color-only state).

---

## 2. P0 — Security & Integrity

### 2.1 No runtime integrity check on bundled rule JSON or WASM
**Where:** `src/background/service-worker.js:1401-1475`, `src/shared/wasm-loader.js:10-18`, `manifest.json:137-147`
**Issue:** `generate-sri-hashes.mjs` only verifies upstream filter-list hashes at *build* time. Bundled `rules/*.json` (~30MB) and `dist/nullify_core_bg.wasm` ship with no signature and are loaded through `chrome.runtime.getURL()` without any post-load hash check. A compromised release artefact (or a tampered local checkout used in dev) is silently trusted.
**Remediation:**
- At CI release time, emit `dist/integrity.json` containing SHA-384 of every bundled rule JSON and the WASM blob, signed with a release key (or pinned via Sigstore).
- On service-worker boot, `await fetch(...)` each ruleset, hash, compare against `integrity.json`. On mismatch, refuse to load and surface a UI error.
- Expose an `INTEGRITY_REPORT` message handler so the options page can show ✅/❌ per file.

### 2.2 `web_accessible_resources` exposes WASM + scriptlet bundle to all origins
**Where:** `manifest.json:137-147`
**Issue:** Both `dist/scriptlets-world.js` and `dist/nullify_core_bg.wasm` are listed under `<all_urls>`. This:
- Lets any site fingerprint the extension via `fetch('chrome-extension://<id>/dist/...')`.
- Lets a page download the scriptlet bundle and analyse it for capability tokens.
**Remediation:**
- The WASM file is consumed by the *content* script (e.g. `youtube-shield.js:32-54`) — that's why it's WAR. Scope `matches` to specific origins where it's actually needed (`*.youtube.com`, etc.), or load WASM via `chrome.scripting.executeScript({ world: 'ISOLATED' })` against a frozen URL the page can't read.
- For `scriptlets-world.js`: per-tab `use_dynamic_url: true` + per-session token already partly does this; add `allowed_origins` to the WAR entry.

### 2.3 `FORCE_CLEAN_ALL_DYNAMIC_RULES` has no privilege gate
**Where:** `src/background/service-worker.js:2913-2924`
**Issue:** The handler accepts any message that passes `sender.id === chrome.runtime.id` (line 2704). Any extension page (popup, options, *or any future surface* such as an offscreen document, a debug page, or a third-party page that sneaks an iframe with the chrome-extension scheme via a misconfigured WAR entry) can wipe every dynamic rule, including the user's allowlist and custom filters.
**Remediation:**
- Introduce a privileged-message allowlist keyed on `sender.url` (must startswith `chrome.runtime.getURL('src/options/')`).
- Require a confirmation token round-trip (e.g. UI requests a one-time nonce, then submits it with the destructive op).
- Same gate should cover `SET_USER_FILTERS`, `SET_ALLOWLIST` clear-all, and any other destructive handler.

### 2.4 User-filter JS-fallback parser drops modifiers silently
**Where:** `src/background/service-worker.js:2118-2189` (specifically `:2193-2229` JS fallback)
**Issue:** When WASM isn't ready, user filters fall through to a JS parser that handles only `$type=` and drops `$domain=`, `$third-party`, `$redirect`, etc. The result: user-provided rules become *broader* than the user wrote — a `||tracker.com^$third-party` becomes effectively `||tracker.com^`, potentially blocking the same domain on its own first-party pages.
**Remediation:**
- Refuse to compile user filters until `wasmReady` is true. Show a UI banner ("Loading filter engine…") and queue.
- Or: bring the JS fallback to feature parity for the modifiers Nullify advertises support for.
- Add a unit test that round-trips representative user filters through both paths and asserts the emitted DNR rules are equivalent.

### 2.5 Non-atomic dynamic rule swap can leave stale rules on SW termination
**Where:** `src/background/service-worker.js:2143-2156`, `:2265-2295`
**Issue:** `chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules })` is called as one API call (atomic in Chrome ≥120), but the **compute → call** path is not transactional with crashes. If we compute new rules, persist intent to storage, then terminate before calling `updateDynamicRules`, the previously-removed ID range is gone but the new range never landed.
**Remediation:**
- Persist a "pending rule generation" marker to `chrome.storage.session` *before* the API call and clear it after. On SW startup, detect a pending marker → re-run rule build.
- Generation-counter the rule IDs so an interrupted swap doesn't leak duplicate IDs in the next attempt.

### 2.6 Filter-list fetch has no timeout / no size cap
**Where:** `src/background/service-worker.js:826`, `src/shared/filter-parser.js` (`fetchAndExpand`)
**Issue:** A malicious or slow CDN can stall the service worker indefinitely or return arbitrarily large responses. SW heap is small; a 1GB list will OOM the worker.
**Remediation:**
- `AbortController` with 30s timeout.
- Stream-and-cap: reject responses larger than ~25MB.
- Fall back to last-known-good cached copy on failure.

---

## 3. P0 — MV3 Lifecycle Correctness

### 3.1 `webNavigation` listeners proceed before `wasmReady`
**Where:** `src/background/service-worker.js:3151-3177` vs `:1081-1131`
**Issue:** `_criticalPromise` is awaited inside the message handler (`:2724`) but `onBeforeNavigate` / `onCommitted` listeners do not await it. Early frame navigations during browser startup get the JS-fallback cosmetic bundle (no Bloom filter, O(n) domain matching) and miss procedural plans that only the WASM path produces.
**Remediation:**
- Wrap the body of every `webNavigation` listener in `await ensureBackgroundSetup()`.
- Make `ensureBackgroundSetup()` idempotent and cheap on warm path.
- Add a telemetry-free counter for "events served before WASM ready" and assert it's 0 in CI integration tests.

### 3.2 `wasmReady` boolean is checked without awaiting in async paths
**Where:** `src/background/service-worker.js:545, 724, 769, 865, 886, 914, 1135, 2124, 2273, 3075` (many)
**Issue:** The flag is set by `await wasmReadyPromise` on startup, but every consumer reads it as a sync boolean. If a consumer is invoked before init resolves (e.g. an `onMessage` for `GET_COSMETIC_BUNDLE` arriving at T+250ms when WASM finishes at T+800ms) and the consumer doesn't await `wasmReadyPromise`, it takes the JS fallback. After WASM finishes, downstream code can call `allowlistMatcher.check()` etc. without a null guard.
**Remediation:**
- Replace `if (wasmReady)` with `if (await waitForWasm(timeoutMs))` in every async path.
- Null-guard every WASM helper struct (`allowlistMatcher`, `trackerMatcher`, `urlSanitizer`).
- Promote `wasmReady` to a private getter that throws if read before init has been awaited.

### 3.3 Stats persistence loses session data on SW termination
**Where:** `src/background/service-worker.js:1812-1819`, `:2054-2063`
**Issue:** Tab stats use a 1.5s debounced flush. Chrome MV3 SWs are killed at any time; the unflushed delta is lost.
**Remediation:**
- Drop the debounce, or shrink to ≤200ms.
- Use `chrome.storage.session` for in-flight counters (zero-cost, evicted with the SW automatically) and roll into `chrome.storage.local` on `chrome.runtime.onSuspend`.

### 3.4 YouTube Shield re-registration race vs allowlist updates
**Where:** `src/background/service-worker.js:1151-1155`, `:1222-1298`
**Issue:** `syncYouTubeShieldRegistration()` is debounced via `youtubeShieldSyncPromise`. Allowlist changes call it async; the in-flight promise can complete *after* a subsequent allowlist mutation, leaving stale `excludeMatches`.
**Remediation:**
- Use an AbortController per sync attempt; cancel on subsequent mutation.
- Compute target state from the latest snapshot inside the promise body, not from the closure-captured snapshot at scheduling time.

### 3.5 Cosmetic bundle in-flight cache poisons on partial failure
**Where:** `src/background/service-worker.js:3003-3063` (`_inFlightRules`)
**Issue:** Two concurrent requests for the same hostname get the same promise. If the DB persist step at the tail fails, the in-flight promise still resolves with the bundle, but the next cold request reads stale DB state.
**Remediation:**
- Separate "compute bundle" from "persist bundle" — only the former is shared via `_inFlightRules`. Persistence runs after the shared resolve and is idempotent + retried.
- Expire entries in `_inFlightRules` after resolve so retries on the same hostname don't pin a failed bundle.

---

## 4. P1 — Filter-Syntax Parity Gaps

### 4.1 `$denyallow`, `$badfilter`, `$header=` not parsed
**Where:** `scripts/build-rules.mjs:444-490` (modifier dispatch)
**Verified missing:** none of these tokens are referenced in the build script. Filter-list rules using them are silently dropped (or worse, parsed as the un-modified rule).
**Remediation:**
- `$badfilter`: collect all `$badfilter` rules in pass 1; in pass 2, suppress matching base rules by canonical-form comparison.
- `$denyallow`: implement as `requestDomains` exclusion plus per-resource-type expansion to DNR.
- `$header=`: emit `modifyHeaders` action with `header` operation `remove`/`set` where applicable.

### 4.2 `$csp` modifier dropped
**Where:** `scripts/build-rules.mjs:398-399` (explicit skip)
**Issue:** Comment says "needs `modifyHeaders` which we do not translate yet". Anti-circumvention rule lists rely heavily on `$csp` to weaken page CSP and unblock cosmetic injection.
**Remediation:**
- Translate `$csp=…` to `{ action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: '<csp>' }] } }`.
- Note the priority interactions with allowlist rules (must lose to the user's allow).

### 4.3 No DNR rule-budget validation
**Where:** `manifest.json:41-117`, `scripts/build-rules.mjs`
**Issue:** Chrome enforces 30,000 rules per static ruleset and 5,000 rules + 1,000 regex rules across enabled dynamic rules; `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS` is 50 but enabled rules across rulesets total are capped at `GUARANTEED_MINIMUM_STATIC_RULES + globally-available` (typically ~330k). Build does not check that *enabled* rulesets sum under the cap; first-run simply fails on user machines.
**Remediation:**
- After build, assert per-ruleset rule count and sum-of-enabled-default rule count. Fail the build with a clear message.
- Surface live budget usage in the options page (`chrome.declarativeNetRequest.getAvailableStaticRuleCount`).

### 4.4 Regex pattern length capped at 150 chars (defensive but undocumented)
**Where:** `scripts/build-rules.mjs:719-757`
**Issue:** Cap is conservative vs Chrome's actual RE2 program-memory limit (~2KB). Tightening trades parity for safety; the choice should be documented and overridable.
**Remediation:** Raise to 256, log dropped patterns to a build-time skipped-rules report (the `rules/skipped/` directory already exists for this).

### 4.5 No `$redirect` resource library
**Where:** `scripts/build-rules.mjs:874-888`
**Issue:** All `$redirect=`/`$redirect-rule=` rules resolve to a single empty `data:` URI regardless of resource type. uBO ships a curated resource library (1x1.gif, noopjs, noopframe, click2load, etc.) that some sites need to render properly when ad slots are blocked.
**Remediation:**
- Vendor uBO's resource library under `assets/redirect-resources/` (CC-licensed).
- Map redirect tokens to their typed data: URIs at build time.

### 4.6 `:if()` / `:if-not()` registered but not implemented
**Where:** `src/content/cosmetic-engine.js:55-56` (registered in `PROC_OPS`); no `case` in `_applyOp`.
**Remediation:** Implement or remove from `PROC_OPS` and the WASM-side enum (`wasm-core/src/lib.rs:~1107`).

### 4.7 `:semantic()` async race
**Where:** `src/content/cosmetic-engine.js:653-663`
**Issue:** Operator dispatches `chrome.runtime.sendMessage('CHECK_SEMANTIC_AD')` but returns synchronously without awaiting. The element is not hidden until a later mutation flush; on static pages it may stay visible for the page lifetime.
**Remediation:** Make procedural application async-aware (already partially supported elsewhere); cache the verdict per text content for re-use.

---

## 5. P1 — Storage & Concurrency

### 5.1 No quota-handling on `chrome.storage.local`
**Where:** `src/shared/db.js:152, 179`, `src/shared/storage.js`
**Issue:** Cosmetic-rule blobs can swell to 5–10MB and `chrome.storage.local` quota is 10MB by default. Failed writes are caught but the user gets no feedback and the in-memory state diverges from disk.
**Remediation:** Detect `QUOTA_BYTES` errors via `chrome.runtime.lastError`, evict LRU page-bundles, surface an "Out of storage" banner.

### 5.2 IndexedDB reads not transaction-consistent across handlers
**Where:** `src/shared/db.js:101-138`
**Issue:** `getScriptletRules()` spawns parallel index queries; popup-vs-SW concurrent writes can produce a non-snapshot view.
**Remediation:** Open a single readonly transaction across all stores per request; or version-stamp results so callers can detect inconsistency and retry.

### 5.3 Allowlist sync absent
**Where:** all uses of allowlist storage
**Issue:** Allowlist is in `chrome.storage.local`, not `chrome.storage.sync`. Users on multiple devices have to maintain it manually. Import/export exists (`src/options/options.js:208-253, 304-323`) but isn't automatic.
**Remediation:** Add an opt-in `chrome.storage.sync` mirror with conflict resolution (last-write-wins keyed by mtime).

---

## 6. P1 — Service-Worker Hardening

### 6.1 Scriptlet-execution errors are swallowed
**Where:** `src/background/service-worker.js:2688-2690, 2877-2878`
**Issue:** `executeScript` is wrapped in try/catch with empty handler. Failures don't surface to the logger and aren't counted.
**Remediation:** Funnel into `errorReport.warnings`, increment a counter, expose via `GET_ERROR_REPORT`.

### 6.2 `contextMenus.removeAll` callback ignores `lastError`
**Where:** `src/background/service-worker.js:1009-1010`
**Remediation:** Check `chrome.runtime.lastError` before calling `create()`; on error, retry once.

### 6.3 `RULESET_ENABLE_PRIORITY` not validated against manifest
**Where:** `src/background/service-worker.js:2301, 2345-2362`
**Issue:** New rulesets added to `manifest.json` but forgotten in the priority array silently get the lowest priority.
**Remediation:** On boot, assert `RULESET_ENABLE_PRIORITY` is a permutation of `chrome.declarativeNetRequest.getAvailableStaticRuleCount` enumerable rulesets. Fail loud.

### 6.4 No size cap on user-supplied custom filters
**Where:** `src/background/service-worker.js:2074-2115`
**Issue:** Cap claimed at 2MB but not enforced consistently across import paths.
**Remediation:** Centralise the cap in one helper; reject + UI-warn on violation.

### 6.5 Cosmetic-rule deduplication missing on user merge
**Where:** `src/background/service-worker.js:3027-3050`
**Issue:** User rules concat with DB rules without dedup; pathological user input multiplies CSS payload.
**Remediation:** `Set`-based dedup per (selector, declaration) before serialisation.

---

## 7. P1 — UI Gaps

### 7.1 No internationalisation
**Where:** missing `_locales/` directory
**Remediation:** Add `_locales/en/messages.json`, switch hardcoded strings to `chrome.i18n.getMessage`, set `default_locale` in the manifest.

### 7.2 Accessibility
**Where:** `src/popup/popup.html:63-92`, `src/options/options.html`
**Issues:** No ARIA labels on icon buttons; no visible focus ring; site-status colour-coded only.
**Remediation:** ARIA labels + roles, `:focus-visible` outlines, redundant icon/text for state badges.

### 7.3 Persona-selector / settings race
**Where:** `src/popup/popup.js:180-196` vs `src/options/options.js:455-475`
**Issue:** Popup sends a delta; options sends the full settings object. Concurrent edits can clobber.
**Remediation:** Server (SW) accepts only deltas with an `ifMatch` version stamp; full-replace is rejected unless the caller's stamp matches current.

### 7.4 Live-logger broadcast unbounded
**Where:** `src/background/service-worker.js:2025-2028, 2957-2964`
**Issue:** Every page on every tab can generate logger events; broadcast cost scales with tab count.
**Remediation:** Logger events are pull-based when the options page is open; SW maintains a ring buffer and the options page subscribes via a long-lived port that's only opened while the logger view is visible.

---

## 8. P2 — Build, Release, Repro

### 8.1 Filter-list URLs hardcoded, not pinned
**Where:** `scripts/build-rules.mjs:61-102`, `scripts/generate-sri-hashes.mjs:24-33`
**Remediation:** Add a `filter-sources.lock.json` with `{url, sha384, fetched_at}` per upstream; CI refuses to build if a fetched body's hash doesn't match the lock. `npm run filters:update` rotates the lock with a manual commit.

### 8.2 No signed releases
**Where:** `scripts/version.mjs`, GitHub release flow
**Remediation:** Sign release artefacts with cosign or minisign; publish the public key in the README; verify in CI.

### 8.3 Build not reproducible
**Where:** combination of mutable filter URLs and timestamps in webpack output
**Remediation:** With 8.1 done, freeze webpack output timestamps via `output.compareBeforeEmit: true` and `optimization.deterministic: true` (already implicit in webpack 5 prod, but assert).

### 8.4 No CI lint/test gate visible
**Where:** `.github/` contents not audited; `package.json` defines `lint` and `build-rules.test.mjs`
**Remediation:** Wire lint, the existing rule-builder tests, and a Puppeteer smoke test (load extension, open a known-ad page, assert blocked count > 0) into a required CI check.

---

## 9. P2 — WASM Core

### 9.1 `.unwrap()` on dynamic data paths
**Where:** `wasm-core/src/lib.rs:970, 1058, 1107` (most are static patterns; `1107` is constant-input AhoCorasick — safe). Risk concentrated in non-static deserialisation paths that already use `unwrap_or_default`.
**Remediation:** Audit each `.unwrap()` and replace with `unwrap_or_else` + `console::warn_1` for any input-dependent path.

### 9.2 No allocator pressure bound
**Where:** `wasm-core/Cargo.toml`
**Remediation:** Set a soft cap on input sizes (e.g. `compile_cosmetic_rules` rejects inputs over 10MB) and return a structured error to JS.

### 9.3 Procedural-plan JSON schema unversioned
**Where:** `wasm-core/src/lib.rs` (`plan_selector_rules_json`) ↔ `src/content/cosmetic-engine.js:159-182`
**Remediation:** Add a `version` field; content-side rejects unknown versions and falls back to recompiling at runtime.

---

## 10. P2 — Manifest

### 10.1 `privacy` permission unused
**Where:** `manifest.json:126`
**Remediation:** Remove unless a feature is planned; reduces permissions warning at install.

### 10.2 `<all_urls>` host permission
**Where:** `manifest.json:131`
**Issue:** Required for content scripts; cannot be narrowed further while remaining a general-purpose blocker.
**Remediation:** Document this in the README install dialog explanation.

### 10.3 No `default_locale`
**Remediation:** See 7.1.

---

## 11. P2 — Missing Features (uBO Parity Wishlist)

| Feature | Status |
|---|---|
| Element zapper | ✅ (`src/popup/popup.js:173-177`) |
| Element picker | ✅ |
| Live logger | ✅ |
| Custom filter import/export | ✅ |
| Per-site allowlist | ✅ |
| Settings import/export | ✅ |
| Scriptlets (uBO parity) | Partial (~30 of ~80) |
| Redirect resources | ❌ — see 4.5 |
| `$denyallow`/`$badfilter`/`$csp`/`$header=` | ❌ — see 4.1, 4.2 |
| Allowlist sync across devices | ❌ — see 5.3 |
| Dashboard (rules-of-the-day, hit counts per filter) | ❌ |
| Per-site CSP/JS toggle | ❌ |
| Network-rule logger with rule-id back-reference | Partial |
| Context-menu "block element" | ❌ (permission declared, handler absent) |
| i18n | ❌ — see 7.1 |
| A11y | ❌ — see 7.2 |
| `chrome.storage.sync` | ❌ |

---

## 12. Suggested Sequencing

**Sprint 1 (security baseline):** 2.1, 2.2, 2.3, 2.6, 6.1, 5.1.
**Sprint 2 (MV3 robustness):** 3.1, 3.2, 3.3, 3.5, 2.5.
**Sprint 3 (filter parity):** 4.1, 4.2, 4.3, 4.5, 4.6.
**Sprint 4 (UI / polish):** 7.1, 7.2, 7.3, 11 (context menu), 5.3.
**Sprint 5 (release hygiene):** 8.1, 8.2, 8.4.

---

## 13. Out of Scope for This Review

- Performance benchmarking under heavy filter load (would require a measurement harness).
- Cross-browser parity (Firefox MV3 has different DNR semantics; `$csp` etc. are supported there).
- Full audit of every scriptlet's argument-handling against uBO upstream — sample-checked only.
- Penetration testing of installed extension against live ad networks.

---

*Generated as part of the staff-engineer code review pass. Each P0/P1 should be filed as a tracked issue before further feature work.*
