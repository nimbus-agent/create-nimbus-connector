# Releasing

`create-nimbus-connector` is published to npm from CI. Nobody publishes from a laptop, and the
workflow is built so that a release which cannot prove itself does not happen.

## The short version

1. Merge Conventional Commits to `main`.
2. release-please opens (or updates) a release PR with the version bump and CHANGELOG.
3. Merge the release PR.
4. CI publishes to npm with provenance and verifies the published artifact.

## Versioning

release-please drives it from commit subjects — `release-please-config.json`, one package at
the repo root, `release-type: node`. The current version lives in
`.release-please-manifest.json`.

| Commit prefix | Bump |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` / `BREAKING CHANGE:` | major |
| `docs:`, `test:`, `chore:`, `refactor:`, `style:` | none |

**Pre-1.0 caveat.** This package is `0.x`, where a breaking change is not signalled by the
version number the way semver signals it after 1.0. That makes the CHANGELOG the real contract,
which is why `CHANGELOG.md` carries a hand-written `Unreleased` section above the generated
ones.

**Write that section for anything release-please cannot see from a subject line.** Two kinds
qualify, and both have shipped:

- **Output changes** — a change to the *bytes* a generated connector contains. An existing user
  regenerating a connector sees a diff, and no commit subject would tell them why. Record the
  diff they will see.
- **Spec-validation breaks** — a spec that parsed before and does not now, such as a newly
  reserved identifier. Name the field and the fix.

## The publish pipeline

`.github/workflows/release.yml`, on push to `main`. Two jobs: `release-please` opens the PR,
and `publish` runs only when `release_created == 'true'`.

The publish job re-proves the package before and after it goes out:

1. **Typecheck, lint and test** — again, on the release commit. A release does not inherit a
   green from an earlier run.
2. **Preflight** — OIDC is available and npm meets the trusted-publishing version floor.
3. **Verify the packed tarball actually runs** — `npm pack`, install the tarball into a clean
   tree, and execute the CLI from it. This is the check that catches a `files` array missing
   something the CLI needs at runtime, which no source-level test can see.
4. **Publish** — `npm publish --provenance`, with a sigstore attestation.
5. **Verify the registry signature** — install the *published* package into a clean tree and
   check its signature cryptographically, retrying while the registry propagates.
6. **Verify the provenance names this repo, workflow and commit** — via the org's shared
   `verify-npm-provenance` action.

Node appears in this workflow and nowhere else in the project. `npm publish --provenance` is
the only way to attach a sigstore attestation to an npm tarball; everything else, including the
tarball-runs check, is Bun.

Every action is pinned to a full-length commit SHA, per org policy. Re-resolve the SHA before
bumping a tag comment.

## Before you merge a release PR

CI covers what it can, but three gates need a Nimbus checkout and therefore cannot run in
Actions. Run them locally against the release commit:

```bash
bun run diff:golden --nimbus-root /path/to/Nimbus
bun run acceptance /path/to/Nimbus
bun run wiring:conformance --nimbus-root /path/to/Nimbus
```

`diff:golden` is the one that matters most: it is the check that the emitted bytes still match
real connectors, and `newrelic`, `datadog`, `grafana` and `sentry` must still report `6/6`.

If the release changes standalone output, also run both acceptance modes — and read
[CLAUDE.md](../CLAUDE.md) on why they are not interchangeable:

```bash
bun run standalone-acceptance --registry        # the published SDK
bun run standalone-acceptance /path/to/nimbus-sdk   # an unreleased SDK branch
```

## Releasing against an unreleased SDK

When a change depends on an `@nimbus-dev/sdk` export that is not published yet, the emitted
dependency floor names a version that does not exist. That is legitimate and the harness
handles it: `--registry` reports `SKIP` for affected fixtures rather than failing, and says on
screen that they were not verified.

**Do not release into that state without deciding it deliberately.** A user installing a
generated standalone package would hit the same unresolvable dependency. Either wait for the
SDK release, or ship knowing that the feature is unusable until it lands and say so in the
CHANGELOG. Once the SDK release is out, re-run `--registry` and confirm the skips became real
passing checks — it needs no code change to re-enable.
