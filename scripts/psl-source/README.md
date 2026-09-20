# `scripts/psl-source/`

`public_suffix_list.dat` is Mozilla's Public Suffix List, vendored **unmodified**
from <https://publicsuffix.org/list/public_suffix_list.dat> — the only URL
upstream supports pulling from. `public_suffix_list.lock.json` records the
sha384 of the bytes in this directory alongside the list's own `VERSION` and
`COMMIT` header lines, the same shape `scripts/filter-lists.lock.json` uses for
the filter snapshots.

## Why the whole file and not just the ICANN section

`docs/REMEDIATION-2026-09.md` §4.5 proposed vendoring the ICANN section only.
The complete file is vendored instead, for three reasons:

- it is byte-for-byte what upstream publishes, so the lock's hash is checkable
  against the source and a refresh is a replace rather than a re-trim;
- the section markers (`===BEGIN ICANN DOMAINS===` / `===END ICANN DOMAINS===`,
  and the PRIVATE pair below them) are *in* the file, so the generator's
  section split is testable against real input rather than assumed;
- the generator needs a curated handful of PRIVATE entries (`github.io`,
  `netlify.app`, `blogspot.com`, …) that a pre-trimmed ICANN-only file could
  not supply.

The size difference is 334 KB against roughly 250 KB, and nothing in this
directory ships in the extension — it is build input for
`scripts/generate-psl.mjs`.

## Refreshing it

The release checklist carries a quarterly reminder. To refresh:

```
curl -sS --fail -o scripts/psl-source/public_suffix_list.dat \
  https://publicsuffix.org/list/public_suffix_list.dat
```

then regenerate the lock's `sha384`, `version`, `commit` and `fetchedAt` from
the new bytes, re-run `node scripts/generate-psl.mjs`, and commit the generated
tables with it. The generator is idempotent: running it twice yields no diff.

## Licence

The list is distributed under the Mozilla Public License 2.0; the licence
header is the first three lines of the `.dat` file and is preserved verbatim.
