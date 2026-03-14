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
| Generic element hiding | ✅ | 42+ selectors bundled |
| Domain-specific element hiding | ✅ | Per-domain rules |
| MutationObserver (dynamic content) | ✅ | Hides dynamically injected ads |
| Procedural cosmetics `:has()` `:upward()` | ✅ | JS-based fallback engine |
| Scriptlet injection (30+ scriptlets) | ✅ | MAIN world via `chrome.scripting` |
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
| Redirect rules ($redirect=) | ✅ | DNR redirect action |
| removeparam ($removeparam=) | ✅ | DNR queryTransform |
| Blocked count badge | ✅ | Per-tab stats |
| Dashboard UI | ✅ | Filter lists, My Filters, Allowlist, Settings |
| CNAME uncloaking | ❌ | Not possible in MV3 |
| Dynamic filtering matrix | ❌ | Requires webRequest (MV2 only) |
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
│   ├── scriptlets/                 # 30+ uBO-compatible scriptlets (run in MAIN world)
│   │   ├── index.js                # Registry + executor (window.__adblockScriptlets)
│   │   ├── abort-on-property-read.js
│   │   ├── abort-on-property-write.js
│   │   ├── set-constant.js
│   │   ├── abort-current-inline-script.js
│   │   ├── json-prune.js
│   │   ├── prevent-fetch.js
│   │   ├── prevent-xhr.js
│   │   └── ...20+ more
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
Filter lists are pre-compiled at build time into Chrome's `declarativeNetRequest` format. Each list becomes an enabled static ruleset. The extension ships with 6 rulesets (30,000+ rules).

### Cosmetic Filtering (Content Scripts)
The content script loads cosmetic rules from `rules/cosmetic-rules.json` and injects a `<style>` element at `document_start`, hiding ad elements before they render. A `MutationObserver` handles dynamically injected content.

### Scriptlet Injection (MAIN world)
The `scriptlets-world.js` bundle is injected into the page's MAIN JavaScript context via a `<script>` tag, exposing `window.__adblockScriptlets`. The service worker then calls `chrome.scripting.executeScript({ world: 'MAIN' })` to invoke specific scriptlets for the current page.

### MV3 Rule Limits
| Type | Limit | Our Usage |
|---|---|---|
| Static rulesets | 50 enabled max | 6 |
| Static rules | 30,000 guaranteed | ~41 (sample), ~150K+ (full) |
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

# Generate sample rules (no network, for local dev)
npm run build:sample-rules

# Build the extension
npm run build:ext

# Or watch mode during development
npm run dev
```

### Full Build (downloads filter lists from internet)

```bash
# Download EasyList, EasyPrivacy, uBO filters and compile to DNR
npm run build:rules

# Then build extension
npm run build:ext
```

### Load in Chrome

1. Navigate to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `nullify/` root directory (not `dist/`)

### Project Scripts

| Script | Description |
|---|---|
| `npm run build` | Full build (download rules + webpack) |
| `npm run build:rules` | Download and compile filter lists only |
| `npm run build:sample-rules` | Generate minimal rules for local testing |
| `npm run build:ext` | Webpack bundle only |
| `npm run dev` | Webpack watch mode |

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
| Scriptlets | ✅ 60+ | ✅ 30+ | Most common covered |
| Dynamic filtering matrix | ✅ | ❌ | Core MV2 feature |
| CNAME uncloaking | ✅ | ❌ | DNS-level, MV3 impossible |
| Response inspection | ✅ | ❌ | No body access in MV3 |
| Rule count | 100K+ | 30K static + 30K dynamic | Per-Chrome limits |

## License

MIT
