# Nullify

**Reduce ads to nothing.** A powerful, privacy-focused Chrome ad blocker built on **Manifest V3** — achieving near-uBlock Origin parity within MV3's constraints.

## Install (no build needed)

1. Go to [**Releases**](https://github.com/inderbhattal/nullify/releases)
2. Download the latest `nullify-vX.X.X.zip`
3. Unzip to a folder
4. Open `chrome://extensions` → enable **Developer mode**
5. Click **Load unpacked** → select the unzipped folder
6. Done! Nullify is active.

## Features

| Feature | Status | Notes |
|---|---|---|
| Ad blocking (EasyList) | ✅ | Via DNR static rulesets |
| Tracker blocking (EasyPrivacy) | ✅ | Via DNR static rulesets |
| Malware blocking | ✅ | Via DNR static rulesets |
| Annoyances (cookie banners, popups) | ✅ | Via DNR + cosmetic |
| Cosmetic filtering (##) | ✅ | Content script CSS injection |
| Generic element hiding | ✅ | 12,000+ generic selectors compiled from the lists |
| Domain-specific element hiding | ✅ | Per-domain rules |
| MutationObserver (dynamic content) | ✅ | Hides dynamically injected ads |
| Procedural cosmetics `:has()` `:upward()` | ✅ | JS-based fallback engine |
| Scriptlet injection | ✅ | MAIN world via `chrome.scripting` |
| abort-on-property-read/write | ✅ | Anti-adblock-detection |
| set-constant | ✅ | Force property values |
| json-prune | ✅ | Strip ad data from JSON APIs |
| prevent-fetch / prevent-xhr | ✅ | Block network requests by pattern |
| Element picker | ✅ | Interactive point-and-click rule creation |
| Import / Export filters | ✅ | Backup and share your custom rules |
| Per-site disable / allowlist | ✅ | DNR allowAllRequests rule |
| Custom user filters | ✅ | Parsed to dynamic DNR rules |
| Filter list enable/disable | ✅ | `updateEnabledRulesets()` |
| HTTP → HTTPS upgrade | ✅ | DNR `upgradeScheme` action |
| WebRTC IP leak blocking | ✅ | `chrome.privacy` API |
| Hyperlink auditing blocking | ✅ | `chrome.privacy` API |
| Redirect rules ($redirect=) | ✅ | DNR redirect action (`$redirect-rule=` is dropped: uBO applies it only when another filter blocks, which DNR cannot express) |
| removeparam ($removeparam=) | ✅ | DNR queryTransform |
| Blocked count badge | ✅ | Per-tab stats |
| Dashboard UI | ✅ | Filter lists, My Filters, Allowlist, Settings |
| Live Logger | ✅ | Real-time network & cosmetic event feed |
| Shadow DOM support | ✅ | Element picker can see through shadow roots |
| :remove() operator | ✅ | Physically delete elements from DOM |
| Bloom Filter | ✅ | Instant $O(1)$ domain lookup optimization |
| IndexedDB Indexing | ✅ | Offload rules from RAM to disk |
| Stealth Mode | ✅ | Strip CSP & rotate Browser Personas |
| CNAME uncloaking | ❌ | Needs DNS resolution; no MV3 API exposes it |
| Dynamic filtering matrix | ❌ | Requires blocking webRequest (MV2 only) |
| Response body inspection | ❌ | Not possible in MV3 |

## Architecture

```
nullify/
├── manifest.json                    # MV3 manifest — declarativeNetRequest + scripting
├── scripts/
│   └── build-rules.mjs             # Downloads EasyList/EasyPrivacy/uBO → DNR JSON
├── src/
│   ├── background/
│   │   └── service-worker.js       # SW: stats, message bus, dynamic rules, privacy
│   ├── content/
│   │   ├── content-main.js         # Entry point, coordinates cosmetic + scriptlets
│   │   └── cosmetic-engine.js      # CSS injection, MutationObserver, procedural filters
│   ├── scriptlets/                 # uBO-compatible scriptlets (run in MAIN world)
│   │   ├── index.js                # Registry + executor (window.__adblockScriptlets)
│   │   ├── abort-on-property-read.js
│   │   ├── abort-on-property-write.js
│   │   ├── set-constant.js
│   │   ├── abort-current-inline-script.js
│   │   ├── json-prune.js
│   │   ├── prevent-fetch.js
│   │   ├── prevent-xhr.js
│   │   └── ...one module per scriptlet family
│   ├── popup/                      # Extension popup (stats, toggle, dashboard link)
│   └── options/                    # Dashboard (filter lists, My Filters, settings)
├── rules/                          # Generated DNR rulesets (build output)
│   ├── easylist.json
│   ├── easyprivacy.json
│   ├── cosmetic-rules.json         # Cosmetic rules for content script
│   └── scriptlet-rules.json        # Scriptlet rules for per-site injection
└── dist/                           # Webpack output (bundled JS/CSS)
```

## How It Works

### Network Blocking (declarativeNetRequest)
Filter lists are pre-compiled at build time into Chrome's `declarativeNetRequest` format. Large lists are sharded across several ruleset files, so one filter list can own several rulesets (EasyList has four, EasyPrivacy three, uBO filters two).

The manifest declares 16 static rulesets and marks 8 of them enabled, which is what Chrome turns on before the service worker runs. On its first start the service worker applies its own defaults (`getDefaultEnabledRulesets`): every one of the ten filter lists is on, which is all 16 ruleset files. It enables them in priority order and skips any shard that does not fit Chrome's shared static-rule budget, retrying on a later start — so how many are live depends on what other DNR extensions are installed. `system-unbreak` is pinned on and cannot be switched off.

### Cosmetic Filtering (Content Scripts)
The content script loads cosmetic rules from `rules/cosmetic-rules.json` and injects a `<style>` element at `document_start`, hiding ad elements before they render. A `MutationObserver` handles dynamically injected content.

### Scriptlet Injection (MAIN world)
The `scriptlets-world.js` bundle is injected into the page's MAIN JavaScript context via a `<script>` tag, exposing `window.__adblockScriptlets`. The service worker then calls `chrome.scripting.executeScript({ world: 'MAIN' })` to invoke specific scriptlets for the current page.

The registry in `src/scriptlets/index.js` dispatches 88 registry names (uBO aliases included) over 45 implementations — uBO ships more, and rules naming one we do not have resolve to nothing rather than failing the page.

### MV3 Rule Limits
| Type | Limit | Our Usage |
|---|---|---|
| Static rulesets | 50 enabled max | 16 declared / 8 enabled in the manifest / 16 requested at runtime |
| Static rules | 30,000 guaranteed | 120,000+ rules across all 16 declared rulesets; 60,000+ in the 8 the manifest enables (the guarantee is one shared pool) |
| Dynamic rules | 30,000 (Chrome 121+) | User rules + allowlist |
| Regex rules | 1,000 per type | Minimal |

## Development

### Prerequisites
- Node.js 18+
- Chrome 120+ (for full scriptlet MAIN world support)

### Quick Start

```bash
# Install dependencies
npm install

# Build the Rust core (wasm-pack; needed by the SW, the content engine
# and the production rule build)
npm run build:wasm

# Generate sample rules (no network, for local dev)
npm run build:sample-rules

# Build the extension
npm run build:ext

# Or watch mode during development
npm run dev
```

### Full Build (compiles the vendored filter lists)

`npm run build:rules` does **not** touch the network. It compiles the
fully-expanded list snapshots committed under `scripts/filter-lists/`, after
verifying each one against `scripts/filter-lists.lock.json`.

It also needs the Rust parser, and refuses to run without it — "Rust parser
unavailable — run `npm run build:wasm` before `npm run build:rules`". It used
to warn once and carry on with a JS extraction fallback, which produced a
different `filter-sources.json` from the one CI produces: two developers could
ship different cosmetic bundles from the same snapshots. Only `--sample` is
exempt.

```bash
# Build the Rust core first — the production rule build requires it.
npm run build:wasm

# Compile EasyList, EasyPrivacy, uBO filters, … to DNR rulesets. Offline.
# Output is staged and only swapped into rules/ on success — as one directory
# rename — so a failed build never destroys or half-replaces the previous
# good rulesets.
npm run build:rules

# Then build extension
npm run build:ext
```

#### Refreshing the upstream lists

Upstream rotates constantly: measured, **6 of 8 lists changed within ~48 h** of
a lock refresh (that was before `ubo-quick-fixes`; there are nine lists now).
When the build fetched at build time, any list rotating between `git tag` and
the CI build failed SRI and killed the release — a success window of minutes.
Fetching is now a separate, deliberate step whose output is reviewed and
committed:

```bash
# 1. Fetch upstream, expand every !#include, and write BOTH the snapshots and
#    the SRI lock from the same bytes (they can never disagree).
npm run refresh:lists

# 2. Review what actually changed. This is the one moment upstream content
#    enters the repo, and it is a plain text diff.
git diff --stat scripts/filter-lists/
git diff scripts/filter-lists/ubo-unbreak.txt

# 3. Recompile and run the gates.
npm run build:rules && npm test

# 4. Commit the snapshots and the lock together.
git add scripts/filter-lists scripts/filter-lists.lock.json
```

A missing snapshot, or a snapshot whose hash does not match the lock, fails the
build with the command to run. Nothing falls back to the network.

#### What ships, and what refreshes afterwards

A release carries two compiled things: the **static DNR rulesets** under
`rules/`, and `rules/filter-sources.json` — a packaged snapshot of every
list's cosmetic and scriptlet rules, stamped with the time it was built. Both
are compiled from the vendored snapshots, so both are as old as the release.

After install the service worker refreshes the nine lists in
`REMOTE_FILTER_LISTS` over the network and stores the result in IndexedDB.
**Only the cosmetic and scriptlet halves travel that path.** Network rules are
static DNR, and static rules can only change when the extension updates — so a
new *block* reaches users on a release, while a new hide or scriptlet reaches
them on the next refresh.

The refresh runs off a `chrome.alarms` alarm whose cadence is gated on the
`refreshCadenceV2` feature flag (`FEATURE_DEFAULTS` in the service worker
records which way it is set in this build):

| | flag off | flag on |
|---|---|---|
| First refresh on a profile that has never checked | a full interval (24 h) after the alarm is created | within a minute |
| Alarm period | fixed 24 h (`CONFIG.FILTER_UPDATE_INTERVAL_MINUTES`) | the shortest `! Expires:` among the stored lists |
| Per-list skip | none — every list is fetched every time | a list inside its own `! Expires:` window is skipped |
| After an extension update | every stored list is overwritten with the packaged snapshot | the fresher of (stored copy, packaged snapshot) wins per list, and a refresh is re-armed for +1 min |

Declared `Expires` values are clamped to **2 h–24 h**
(`CONFIG.FILTER_EXPIRES_FLOOR_MINUTES` … `CONFIG.FILTER_UPDATE_INTERVAL_MINUTES`),
so a list asking for 1 hour does not hammer its mirror and one asking for 7
days still gets checked daily. The options page's "Update All" ignores the
windows and fetches everything.

#### `ubo-quick-fixes` is the volatile one — a deliberate trade-off

`scripts/filter-lists/ubo-quick-fixes.txt` is a snapshot of uAssets'
[`quick-fixes.txt`](https://github.com/uBlockOrigin/uAssets/blob/master/filters/quick-fixes.txt),
which declares:

```
! Expires: 8 hours
```

That is **by far the shortest expiry of anything we carry** — the other eight
snapshots declare 12 h (malware), 4 days (EasyList, EasyPrivacy), 5 days
(badware, uBO filters, uBO unbreak) and 7 days (uBO annoyances, uBO cookie
notices). quick-fixes.txt is where uBO lands its *same-day*
counter-moves, and it is the only place uBO's modern YouTube machinery lives
(`json-prune-fetch-response` / `json-prune-xhr-response` on `/youtubei/v1/player`,
`trusted-json-edit-xhr-request` request shaping, `trusted-prevent-dom-bypass`);
none of it is in `filters.txt`, which we ingest as `ubo-filters`.

The consequence of vendoring it is real and is stated here rather than left
implicit: **a snapshot of this list goes stale within a working day, and its
static DNR rules only reach users on a release.** We accept that because:

- The alternative — fetching at build time — did not merely go stale, it broke
  releases outright (see above). Staleness degrades; a failed SRI check ships
  nothing at all.
- Its network rules are a minority of the list: at the last refresh, 60 of its
  463 lines are network filters against 228 cosmetic/scriptlet ones. Almost
  everything that matters is cosmetic/scriptlet, and **those are re-fetched by
  the service worker** — `ubo-quick-fixes` is registered in
  `REMOTE_FILTER_LISTS`, so a fresh YouTube counter-move reaches installed
  users without a release, on the cadence tabulated above.
- `npm run refresh:lists` immediately before tagging keeps the snapshot within
  hours of upstream, and the diff is small enough to actually read.

If YouTube breaks and the fix is known to be in quick-fixes.txt, the response is
`npm run refresh:lists && npm run build:rules` and a release — not a build-time
fetch.

The list is treated as **trusted** (`TRUSTED_FILTER_LIST_IDS` in the service
worker): it is a `ublock-*` list, matching uBO's own `trustedListPrefixes:
'ublock-'` gate, and its YouTube rules depend on `trusted-replace-*`,
`trusted-json-edit-*` and `trusted-rpnt`, which are trust-gated.

### Load in Chrome

1. Navigate to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `nullify/` root directory (not `dist/`)

## Release & Versioning

To release a new version, use the automated bump script. This will update `package.json`, `manifest.json`, and `package-lock.json`, commit the changes, and create a git tag.

```bash
# Bump a patch version (1.0.0 -> 1.0.1)
npm run version:bump patch

# Bump a minor version (1.0.0 -> 1.1.0)
npm run version:bump minor

# Bump a major version (1.0.0 -> 2.0.0)
npm run version:bump major

# Sync local branch and tags to GitHub
git push origin main --follow-tags
```

### Project Scripts

| Script | Description |
|---|---|
| `npm run build` | Full build (Rust core + compile rules + webpack) |
| `npm run build:rules` | Compile the vendored lists to DNR rulesets (offline, SRI-verified) |
| `npm run refresh:lists` | Fetch upstream and rewrite `scripts/filter-lists/` + the SRI lock (review and commit the diff) |
| `npm run build:sample-rules` | Generate minimal rules for local testing |
| `npm run build:ext` | Webpack bundle only |
| `npm run build:wasm` | Build the Rust core with `wasm-pack` into `src/shared/wasm/` |
| `npm run dev` | Rust core + sample rules, then webpack watch mode |

## Filter Syntax Support

This extension uses the standard **ABP/EasyList filter syntax** with uBlock Origin extensions:

### Network Rules
```
||ads.example.com^                    # Block domain
||ads.example.com^$script,image       # Block specific resource types
||ads.example.com^$third-party        # Block only third-party requests
@@||safe.example.com^                 # Exception (allow)
||example.com^$redirect=1x1.gif       # Redirect to blank pixel
||example.com^$removeparam=utm_source # Strip query parameter
```

### Cosmetic Rules
```
##.ad-banner                          # Generic element hiding
example.com##.sidebar-ad             # Domain-specific hiding
example.com#@#.false-positive        # Exception
##[class*="advertisement"]           # Attribute selector
##.ads:upward(2)                     # Procedural: hide grandparent
##.ad-container:has(.ad-slot)        # Procedural: :has()
```

### Scriptlet Rules
```
example.com##+js(abort-on-property-read, _sp_)
example.com##+js(set-constant, adblockEnabled, false)
example.com##+js(json-prune, data.ads data.tracking)
example.com##+js(prevent-fetch, /analytics/)
```

## MV3 Limitations vs uBlock Origin

| Feature | uBlock Origin (MV2) | Nullify | Notes |
|---|---|---|---|
| Network blocking | ✅ Full webRequest | ✅ DNR | ~95% parity |
| Cosmetic filtering | ✅ Full + procedural | ✅ CSS + JS procedural | Minor gaps |
| Scriptlets | ✅ | ✅ 88 names / 45 implementations | A rule naming one we do not have resolves to nothing |
| Dynamic filtering matrix | ✅ | ❌ | Core MV2 feature |
| CNAME uncloaking | ✅ | ❌ | DNS-level, MV3 impossible |
| Response inspection | ✅ | ❌ | No body access in MV3 |
| Rule count | 100K+ | 30K static + 30K dynamic | Per-Chrome limits |

### `$all` blocks the navigation, not just the page's requests

`||host^$all` compiles to a DNR block over every resource type **including
`main_frame`**, on every list that carries it — which is what the option means
in uBO. In the vendored snapshots that is 1,385 rules on the badware list
(`anti-adblock`, covering 1,353 hosts) and 7,748 on the malware list, almost
all of the latter URL-specific rather than whole-host.

So a host on the badware list does not load with its subresources stripped:
**the navigation to it is blocked** and Chrome shows its own error page. That
is the intent — those two lists exist to stop the user reaching the host at
all — but it is the one place a filter list changes what typing a URL does.
The malware list has done this for several releases; the badware list has
since v4.9.0. Allowlisting the site turns it off, as with any other rule.

### Genuinely impossible under MV3

Not "not yet" — no MV3 API expresses these, so they are not on a roadmap:

- **Dynamic filtering matrix** — uBO's per-site rule grid needs blocking `webRequest`.
- **CNAME uncloaking** — needs DNS resolution; DNR matches the URL as written.
- **`$replace=`, HTML filtering (`##^`), any response-body inspection** — MV3 never hands an extension a response body.
- **`$ipaddress=`** — DNR conditions match URLs, not resolved addresses.
- **Exact `$strict1p` / `$strict3p`** — DNR's `domainType` compares registrable domains, so `a.example.com` → `b.example.com` is first-party to it either way.
- **True `$popup` semantics** — DNR has no window-open signal. `$popup` is approximated by a `main_frame` block on the popped URL, which also blocks a deliberate navigation to it.
- **`$urlskip=`** beyond what a DNR `regexSubstitution` can express safely.

Filters using these are dropped at compile time rather than shipped with the
modifier stripped: a half-understood rule blocks more than its author wrote.

## License

MIT
