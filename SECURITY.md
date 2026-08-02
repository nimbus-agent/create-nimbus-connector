# Security Policy

`create-nimbus-connector` is an MIT-licensed **code generator**. It is a developer tool: it
runs on an author's machine or in CI, reads a JSON spec, and writes source files. It holds no
credentials, serves no traffic, and is not part of the Nimbus runtime.

## Reporting a vulnerability

Report security issues **privately** rather than opening a public issue:

- GitHub [private vulnerability reporting](https://github.com/nimbus-agent/create-nimbus-connector/security/advisories/new)
  for this repository, or
- the disclosure process in the main
  [Nimbus security policy](https://github.com/nimbus-agent/Nimbus/security/policy).

Include reproduction steps, the `create-nimbus-connector` version, and the spec file that
triggers it where one is involved. We aim to acknowledge reports within a few business days.

## Scope

**In scope — this repo:**

- The generator emitting source that is unsafe, or that differs from what the spec describes.
- Spec-driven injection: a crafted spec producing output that escapes the intended structure
  of an emitted file. Emitted values reach a manifest, a `package.json` and TypeScript source,
  and the boundaries between "data from the spec" and "code" are the interesting surface here.
- The published npm tarball: its contents, its provenance attestation, its dependency tree.
- The CLI reading or writing paths outside its declared output directory.

**Out of scope — report to [Nimbus](https://github.com/nimbus-agent/Nimbus) instead:**

- Anything in the gateway, the Vault, the HITL gate, or the connector sandbox.
- The behaviour of a *hand-written* connector, or of a generated one after you edit it.
- The `@nimbus-dev/sdk` helpers a generated connector imports — those belong to
  [nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk).

## Posture

**A spec is trusted input, and you should treat it as code.** The generator writes files to
disk from a spec you supply. Running it against a spec from an untrusted source is equivalent
to running untrusted code generation — review a spec you did not write before generating from
it, the same way you would review a `package.json` script.

**Connector output overwrites in place.** `writeFiles` creates parent directories and writes;
there is no existence check. Point `--out-dir` somewhere you intend to replace, and use
`--dry-run` first. The two Gateway wiring files are the exception and refuse to overwrite
without `--force`.

**Generated connectors read credentials from the environment only.** No credential is ever
written into generated source, a manifest, or a README. Emitted accessors throw when a
variable is missing or empty rather than proceeding with an empty credential.

**Escaping is a correctness rule enforced by tests.** The path-template DSL distinguishes
`${arg.X}` from `${arg.X|enc}`, and the manifest emitter's `$`-safety was a fixed defect with a
regression test — a spec-supplied filesystem path containing `$&` or `$$` previously corrupted
`nimbus.extension.json`. Report anything in this family.

**Supply chain.** The published package declares its dependencies in `package.json`, is
published from CI with `npm publish --provenance`, and the release workflow verifies the
resulting tarball's registry signature and that the provenance attestation names this
repository, workflow and commit. Every GitHub Action is pinned to a full-length commit SHA.
Dependabot and CodeQL run on this repo.

**No telemetry.** The CLI makes no network calls. `bun install` in a *generated* standalone
package resolves `@nimbus-dev/sdk` from npm; that is the package manager, not this tool.

## Generated connectors are your responsibility

The generator reproduces a shape; it does not audit your API. A generated connector's network
permissions, its `hitlRequired` capabilities and its credential handling come from the spec you
wrote. Review `nimbus.extension.json` before shipping — in particular that `permissions.network`
lists only hosts the connector should reach, and that any tool which mutates declares a
non-`read` `effect`.
