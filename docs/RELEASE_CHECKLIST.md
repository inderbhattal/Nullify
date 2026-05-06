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
- [ ] `docs/REVIEW.md` and `docs/IMPLEMENTATION.md` reviewed for any
      newly-applicable items since the last release
- [ ] No P0 from `docs/REVIEW.md` regressed in this cycle

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

## Anti-adblock check

- [ ] Visit a known anti-adblock-shielded site (e.g. one of the targets
      in `rules/anti-adblock.json` source). The site loads; if it shows
      an anti-adblock prompt, it's *expected to be bypassed* — not
      shown to the user.

## Settings & UI

- [ ] Open Options page; all sections render, no console errors.
- [ ] Toggle a filter list off then on; popup blocked count updates.
- [ ] Add a domain to the allowlist via the options page; popup
      reflects it on a tab matching that domain.
- [ ] Live Logger view streams events.
- [ ] Settings export → import round-trip preserves allowlist + user
      filters.

## Diagnostics

- [ ] `chrome://extensions` inspector shows zero unhandled errors over
      5 minutes of normal browsing.
- [ ] `GET_ERROR_REPORT` (via the options diagnostic surface) returns
      `criticalCount === 0` on a clean install.

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
relevant items in `docs/REVIEW.md` / `docs/IMPLEMENTATION.md`. Notes:

_______________________________________________________________________
_______________________________________________________________________
_______________________________________________________________________
