# Governance

How decisions get made about `create-nimbus-connector`. Deliberately lightweight — this is a
single-package developer tool, not a contract many products depend on. It is a statement of how
the project is run, not a legal document.

Contract-shaped decisions belong upstream: `@nimbus-dev/sdk`'s surface is governed in
[nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk/blob/main/docs/GOVERNANCE.md), and what a
connector *is* is governed in [Nimbus](https://github.com/nimbus-agent/Nimbus). This repo
governs one question: **what the generator emits, and how we know it is right.**

## Principles

- **The corpus decides.** When a design question has a factual answer in the 94 connectors,
  that answer wins over preference. "27 of 29 manifests write it collapsed" settles a formatting
  debate. Measure before arguing, and record the measurement next to the choice.
- **A gap is documented, never hidden.** Where the generator cannot reproduce something, it says
  so — a stub tool, an entry under [Known limitations](./ROADMAP.md#known-limitations), a file
  omitted from an expectation entry. Editing `expectations.json` to make a diff disappear is the
  one thing that is never acceptable.
- **No check that passes while asserting nothing.** A gate must state what it proves. A gate that
  silently skips when its input is missing is worse than no gate, because it reads as coverage.
- **Emitted bytes are a public interface.** Users regenerate connectors. A change to the bytes is
  a change users see, and it belongs in the CHANGELOG even when no commit subject would carry it.
- **Claims are qualified honestly.** If a gate could not run, say so rather than substituting a
  weaker one that passed.

## Roles

- **Maintainers** — merge rights, releases, and responsibility for the byte-safety invariant.
  Today a small first-party group.
- **Contributors** — anyone opening a PR. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Decisions

**Ordinary changes** — a new spec field, an emitter fix, a fixture — are decided in the pull
request.

**Stage-shaped changes** — anything that widens what the spec language can express — start by
**measuring the corpus**, before any code. Four stages have gone through this, and it exists
because the alternative is expensive: discovering the corpus does not look the way you assumed,
halfway through an emitter.

State in the PR what you counted and how, what you decided, and what you decided *against*.
Then put the durable half where it will still be read: a gap the generator cannot close goes
under [Known limitations](./ROADMAP.md#known-limitations), a measured-and-rejected proposal
under [Considered and declined](./ROADMAP.md#considered-and-declined), and a measurement that
justifies a default goes in the README beside the field it justifies.

Earlier stages produced long standalone design documents. Those have been retired into the
pages above — reasoning that lives only in a dated document nobody opens again is reasoning
that gets re-litigated.

**Changes that move locked bytes** need explicit justification in the PR, plus a `diff:golden`
run showing the four locked fixtures still at 6/6.

**Direction** — [ROADMAP.md](./ROADMAP.md). Its consolidation section states an intent to
absorb `@nimbus-dev/create-connector`; that is a direction with stated conditions, not a
deprecation. Changing it is a maintainer decision made in the open.

## Reviews

Every PR gets a human review. Automated review (CodeRabbit, Sonar, CodeQL) runs alongside and
is advisory: a finding is verified against the code before it is implemented or dismissed, and
the reasoning is recorded in the thread. Neither a bot's approval nor its objection decides
anything on its own.

## Keeping the unattended checks running

This repository is built to sit quiet for long stretches. Two of its checks are the ones that
matter most in exactly that state, and both are the kind that stop running without turning
anything red. **A maintainer who checks in twice a year should read this section first.**

**The two scheduled workflows are auto-disabled after 60 days of repository inactivity.** That
is a GitHub platform behaviour, not a setting in this repository, and it applies to
`acceptance.yml`'s daily `--registry` run and `codeql.yml`'s weekly scan. Those two are
precisely the unattended safety nets: the daily acceptance run exists because the published
`@nimbus-dev/sdk` can change without a single commit here, and the weekly CodeQL run exists so a
newly published query finds existing code rather than waiting for someone to touch it. The thing
that keeps the window open today is incidental — Dependabot's weekly branch pushes count as
activity — which means the protection lapses exactly when nothing needs updating, the case it
was for.

GitHub emails the repository admins before disabling them, so the instruction is short and it is
the whole of the mitigation: **re-enable them, and do not read a green Actions tab as proof they
ran.** A disabled schedule shows no failure. Check the workflow's last run date, not its last
result. A keep-alive workflow was considered and declined — it would manufacture activity to
defeat a mechanism whose purpose is to detect its absence, which is the same shape as a gate
that passes while asserting nothing.

**The `sonar` workflow can go red for a reason no commit fixes.** SonarCloud's quality gate
includes `new_security_hotspots_reviewed`, which is satisfied by a human reviewing the hotspot
in the SonarCloud UI and recording a verdict — not by changing code. A red `sonar` check is
therefore not automatically a defect in the pull request. Read the finding first: if it is an
unreviewed hotspot, review it there and say so in the thread, the same way any other advisory
finding is verified before being implemented or dismissed.

## Compatibility

Pre-1.0, so the version number does not carry the usual semver promise. In practice:

- **Spec compatibility** is taken seriously — a spec that parsed under a published version
  should keep parsing. Where that has broken (a newly reserved identifier), it is called out in
  the CHANGELOG with the fix.
- **Emitted-byte compatibility** is not promised, because tracking the corpus is the point. It
  is always *disclosed*.
- **Internal modules** carry no compatibility promise. The CLI and the spec format are the
  interface.

## Licensing

MIT, and it stays MIT. **No AGPL source may be copied into this repository** — see
[GLOSSARY.md](./GLOSSARY.md#the-three-repos). This is a hard constraint that shapes the test
strategy, and any change that would vendor Nimbus source is rejected on that ground alone.
