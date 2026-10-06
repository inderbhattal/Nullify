# Nullify — Release Checklist

Sign-off required before tagging any release. Some user journeys cannot
be automated reliably (live YouTube, banking sites, anti-adblock pages),
so they live here.

The release branch is gated on a copy of this file with every box ticked
and the operator's name + date filled in.

---

**Release version:** vX.Y.Z
**Operator:** _________________
**Date:** ____________________

---

## Pre-flight

- [ ] `npm test` passes locally
- [ ] `npm run lint` passes locally
- [ ] CI green on the tagged commit (test.yml + build.yml)
- [ ] `docs/REVIEW-2026-09.md` and `docs/IMPLEMENTATION.md` reviewed for any
      newly-applicable items since the last release
- [ ] No P0 from `docs/REVIEW-2026-09.md` §3 regressed in this cycle
- [ ] Every item this release claims from `docs/REMEDIATION-2026-09.md` is
      landed, and the ones it does not claim are still listed there
- [ ] `CHROME_MAJOR_FALLBACK` in `src/shared/personas.js` bumped to the
      current stable Chrome major. It is the persona reported when the
      browser's own version cannot be read, so a stale value is a
      fingerprint that says "this profile is not what it claims".
- [ ] *(once the PSL vendoring lands)* `scripts/psl-source/public_suffix_list.dat`
      refreshed if it is more than a quarter old — check the date in its
      header line, then regenerate with `node scripts/generate-psl.mjs`. It
      is the one vendored input with no SRI lock behind it.

## Manual smoke — fresh install

> Use a fresh Chrome profile (or `chrome://settings/resetProfileSettings`).
> Load the unpacked extension from the build artifact ZIP, NOT from the
> dev `dist/` directory.

- [ ] Extension loads without errors in `chrome://extensions` inspector
- [ ] Service worker reaches "active" state within 5 s of install
- [ ] Popup opens and shows a non-zero blocked count after 30 s of
      browsing five reference sites:
      - [ ] cnn.com
      - [ ] nytimes.com
      - [ ] twitch.tv
      - [ ] youtube.com
      - [ ] gmail.com
- [ ] Compare each site against the screenshot baselines in
      `docs/baselines/` (if any). Note visible regressions:
      _______________________________________________________________

## YouTube — the high-blast-radius journey

These are the scenarios the unit harness cannot reach.

- [ ] **Cold:** open https://www.youtube.com/watch?v=<short ad-bearing
      video>. Pre-roll ad does NOT play. Mid-roll skipped silently.
- [ ] **Allowlist add (live):** with the YT video tab open, click the
      popup's "Allow on this site" toggle. **Without reloading the
      page**, navigate to a new video. Ads now appear. (Catches the
      `b327340`/`3a35970`/`f9b4f39` regression class.)
- [ ] **Allowlist remove (live):** with allowlist on, toggle it off.
      **Without reloading**, navigate to a new video. Ads suppressed
      again.
- [ ] **Music subdomain:** allowlist `music.youtube.com` only. Confirm
      `www.youtube.com` ads are still blocked, `music.youtube.com` ads
      are allowed.
- [ ] **SW restart:** in `chrome://extensions`, click the service-worker
      "Inspect" link, then in DevTools → Application → Service Workers
      → click "stop". Within 30 s open a new YT tab; ads suppressed
      without manual extension reload.
- [ ] **Upgrade-in-place:** install vN-1 from the prior release ZIP,
      browse YT for a minute, then in `chrome://extensions` click
      "Reload" on Nullify with the new vN unzipped (or load vN over the
      top via the button). YT continues blocking with no manual page
      refresh.

## Gmail — the cosmetic regression class (commit 9447103)

- [ ] Open mail.google.com. Inbox renders correctly; no missing message
      bodies, no missing left rail, no missing toolbar.
- [ ] Compose a new email. Compose pane renders correctly.
- [ ] Open a thread. Message body and reply box visible.

## Security lists — the navigation block

`$all` compiles to a block over every resource type *including*
`main_frame`, so a host on `anti-adblock` (uAssets' badware.txt) or on
`malware` does not load with its subresources stripped — the navigation
itself is refused. It is the one filter-list behavior that changes what
typing a URL does (README, "`$all` blocks the navigation", carries the
measured host counts), and no automated test exercises it against a real
Chrome. Both directions matter: the block must fire, and it must not fire
on anything else.

Pick a host from the build being shipped — the list rotates on every
`npm run refresh:lists`, so do not reuse last release's:

```bash
grep -m1 -oP '^\|\|\K[^/^*]+(?=\^\$all$)' scripts/filter-lists/anti-adblock.txt
```

- [ ] **The block fires:** type `http://<that host>/` in the address bar.
      Chrome shows its own error page (`ERR_BLOCKED_BY_CLIENT`) — not the
      site, not a partly-rendered page, and no download begins.
- [ ] **The allowlist still outranks it:** from the popup on that error
      page, allow the site and reload — it loads. Then remove it again.
      (`tests/build-artifacts.test.mjs` pins the priority band; this is the
      live half of it.)
- [ ] **No false positive:** with both lists enabled, `https://example.com/`
      and the five reference sites above still load normally. A block that
      fires too widely is worse than one that does not fire.
- [ ] **Malware list:** its entries are mostly URL-specific rather than
      whole-host, so check one *without navigating to it* — if the block had
      regressed, navigating would actually fetch the file. From the
      service-worker console, with a `||host/path^$all` URL taken from
      `scripts/filter-lists/malware.txt`:

          await chrome.declarativeNetRequest.testMatchOutcome({
            url: 'https://<that URL>',
            type: 'main_frame',
            initiator: 'https://example.com',
          })

      `matchedRules` is non-empty. (`testMatchOutcome` needs the
      `declarativeNetRequestFeedback` permission, which the manifest holds,
      and an unpacked load — which is how this smoke runs.)

## Anti-adblock walls

Not the list above: `anti-adblock` is an id kept for compatibility, its
source is badware.txt and the UI calls it "uBO Badware Risks". Walls that
demand you switch the blocker off are handled by the scriptlets —
`abort-on-property-read` and friends. Pick a target from the build:

```bash
grep -hoP '^[a-z0-9.-]+(?=##\+js\(aopr,)' scripts/filter-lists/*.txt | head -5
```

- [ ] Visit one of those domains. No "disable your ad blocker"
      interstitial; the page's own content renders.
- [ ] In that page's console, `window.__adblockScriptlets` is defined — so a
      clean page means the bypass ran, not that the site dropped its wall.

## Settings & UI

- [ ] Open Options page; all sections render, no console errors.
- [ ] Toggle a filter list off then on; popup blocked count updates.
- [ ] Add a domain to the allowlist via the options page; popup
      reflects it on a tab matching that domain.
- [ ] Live Logger view streams events; Export writes a file.
- [ ] My Filters export → import round-trip preserves the filter text.
- [ ] Allowlist export → import round-trip preserves the domains, and an
      import containing an invalid entry (e.g. `co.uk`) reports it as
      rejected rather than silently dropping it.
- [ ] Each Import refuses the other tab's export: an Allowlist export on My
      Filters, and a My Filters export on the Allowlist, each show an error
      naming the right tab and leave the filters and the allowlist unchanged.
      An allowlist file with any line that is not a site (a filter rule such
      as `example.com##.ad`, or a page URL) imports nothing and lists that
      line; `example.com` is never added from it.

## Diagnostics

- [ ] `chrome://extensions` inspector shows zero unhandled errors over
      5 minutes of normal browsing.
- [ ] From the service-worker console, `chrome.runtime.sendMessage(
      {type:'GET_ERROR_REPORT'})` returns `criticalCount === 0` on a
      clean install, and `scriptlets.unknown` is empty or small.

      There is no options-page diagnostic surface, so this step is
      console-only. `GET_ERROR_REPORT` now aggregates the unknown-scriptlet
      counter and the refused-untrusted-scriptlet counter, neither of which
      any UI displays — worth building a view for, since a coverage
      regression is only observable if somebody looks.

## Incognito (separate storage)

- [ ] Enable extension in incognito (`chrome://extensions` → details →
      "Allow in Incognito"). Open an incognito window. Extension boots
      cleanly; ads suppressed on cnn.com.

---

## Sign-off

By ticking the boxes above, I confirm Nullify vX.Y.Z is safe to ship.

**Operator signature:** _________________

---

## Failure-mode log

If any item failed, do NOT tag the release. File issues against the
relevant items in `docs/REVIEW-2026-09.md` / `docs/IMPLEMENTATION.md`. Notes:

_______________________________________________________________________
_______________________________________________________________________
_______________________________________________________________________
