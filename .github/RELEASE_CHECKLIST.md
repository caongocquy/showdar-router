# Showdar Router v0.6.0 — release operator checklist

Read-only preflight for the Trusted Publishing flow, plus GO/NO-GO gates.
Publication itself is a separate, explicitly authorized step.

## Verified automatically (no manual step)

| Fact | Value | Where enforced |
| --- | --- | --- |
| npm package name | `showdar-router` | `release.yml` "Validate tag and package metadata" |
| Publish trigger | `push: tags: v*` only — never a branch or PR | `release.yml` `on:` |
| GitHub Actions identity | workflow file `release.yml`, job `publish-npm` | `release.yml` |
| OIDC token | `permissions: id-token: write` present | `release.yml` `publish-npm` |
| npm CLI for provenance | pinned `npm@11.5.1` (>= 11.5.1 required) | `release.yml` "Use Trusted Publishing-compatible npm" |
| Token-based auth | none — no `.npmrc`, no `NPM_TOKEN`; OIDC only | repo scan |
| Publish command | `npm publish --access public --provenance` | `release.yml` |
| Tag == package version | tag `vX.Y.Z` must equal `cli/package.json` version | `release.yml` metadata step |
| bin target | `showdar-router` → `cli.js` | `release.yml` metadata step |
| Duplicate publish | `already-exists` is detected and skipped, not re-published | `release.yml` "Publish or confirm existing npm version" |
| Release assets | attached by a separate tag-gated run, no-clobber on tag push | `release-artifacts.yml` |

## Manual verification (npm website — cannot be inspected from CI)

1. npmjs.com → `showdar-router` → **Settings → Trusted Publisher** must be:
   - Publisher: **GitHub Actions**
   - Organization/user: `caongocquy`
   - Repository: `showdar-router`
   - Workflow filename: `release.yml`
   - Environment: *(empty)*
2. Confirm the publishing account still owns `showdar-router` and has 2FA enabled.
3. `npm view showdar-router versions` must **not** contain `0.6.0` before publishing.

## GO / NO-GO conditions

**GO only if all are true:**
- [ ] `main` is green and the release PR is merged (R2 verification approved).
- [ ] `main` SHA recorded; `cli/package.json` version is `0.6.0`.
- [ ] Release regression gate PASS (21 files) and four-platform bundle smoke PASS on `main`.
- [ ] Node compatibility matrix PASS (20.9.0 / 22 / 24) or the floor is documented.
- [ ] `release-artifacts-dryrun.yml` `verify-set` PASS (exactly 4 archives, 4 checksums).
- [ ] npm Trusted Publisher config matches the table above (manual step done).
- [ ] `npm view showdar-router@0.6.0` returns E404.
- [ ] No `v0.6.0` tag or GitHub Release already exists.

**NO-GO if any:**
- Any CI workflow failing on the recorded `main` SHA.
- Version mismatch between tag, `cli/package.json`, and changelog.
- Trusted Publisher not configured, or 2FA/ownership unresolved.
- Any check suggests a duplicate/partial publish already exists.

## Execution order (only after explicit authorization)

1. `git tag v0.6.0 <recorded-main-sha>` and push the tag (triggers `release.yml`, then `release-artifacts.yml`).
2. Confirm npm shows `showdar-router@0.6.0` with provenance, and the GitHub Release lists
   exactly the four archives plus their `.sha256` files.

## Recovery for a partially published release

- **npm published, GitHub Release missing:** re-run the `release.yml` job for the tag; publish
  detects `already-exists` and proceeds to create the release. Safe and idempotent.
- **Assets missing or partial:** run `release-artifacts.yml` via `workflow_dispatch` with
  `tag=v0.6.0`. That path is the only one allowed to `--clobber`; a tag push deliberately
  refuses to overwrite, so a partial upload stays detectable.
- **Wrong version published:** never unpublish silently; publish a corrected patch version and
  document it, since the npm version is immutable for consumers.
