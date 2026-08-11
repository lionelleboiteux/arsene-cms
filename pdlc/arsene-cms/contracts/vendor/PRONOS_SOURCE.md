# Vendored copy of `pronos`'s OpenAPI contract

`pronos-openapi.yaml` in this directory is a **verbatim copy** of

```
/Users/lionelleboiteux/work/pronos/pdlc/jeu-des-pronos/contracts/openapi.yaml
```

pinned to:

| | |
|---|---|
| Source repo | `pronos` ("Jeu des Pronos") |
| Pinned commit | `d8f308de6aec0b1207df5a447edcf6fd39f77832` |
| Commit date | 2026-08-11T15:23:04+01:00 |
| Vendored on | 2026-08-11 |
| Vendored by | Arsène red gate (`pdlc/arsene-cms/03-red-evidence.v1.md`) |
| Lines | 1606 |

## Why the whole file, not an extract

`pdlc/arsene-cms/contracts/pronos-fixtures.consumer.md` §6: Prism needs the
full document to resolve `$ref`s (`CurrentGameweekResponse` →
`League`/`Gameweek`/`Game`/`Team` → `Error`), and a hand-trimmed copy would
silently drift from what `pronos` actually ships.

## How to refresh

```
scripts/update-pronos-vendor.sh
```

Run manually, never in CI. Nothing in Arsène's CI fetches this over the
network or from a live `pronos` deployment — the consumer test
(`tests/contract/pronos-fixtures.prism.test.ts`) mocks this file with Prism.
