# Changelog

## Unreleased

Hand-written; release-please prepends its own generated section above this one at release
time, and these notes then move down with it. Recorded here because release-please derives
its entries from commit subjects, and a change to the BYTES a generated connector contains
is something an existing user needs told even when no subject line would say so.

### Features

* **spec:** `filter.fields` widens from a flat list of plain-key strings to three entry
  kinds — a plain key, `{ "path": [...] }` for a nested value, and `{ "tags": "text" |
  "objects" }` — composing the primitives `shared/search-filter.ts` and
  `@nimbus-dev/sdk/connector-kit` already ship, instead of always falling back to a throwing
  stub the moment a filter needs more than top-level keys. Measured against the checkout at
  `f4e9d93d`: of the 40 corpus filter files that hand-write an extractor, **9** are reachable
  this way; the other 31 (30 defining a local helper function or needing logic no entry kind
  expresses, one hand-rolled) still emit the stub. `filter.fields: string[]` and `filter.tags:
  boolean` keep their exact current meaning and byte output; see **Breaking** below for the
  identifiers now reserved.

* **spec:** a tool may declare a `query` array — `{ "name", "arg", "omitWhen"? }` — for a
  parameter the fixed `path` template DSL cannot express: one sent only when an optional
  argument is present (`omitWhen: "absent"`) or non-empty (`omitWhen: "empty"`, string args
  only), or unconditionally when `omitWhen` is omitted. Composes `new URL(...)` and guarded
  `searchParams.set(...)` calls; the value is wrapped in `String(...)` for a `number` or
  `boolean` arg and passed bare for a `string`, by type, not by whether the entry is guarded.
  Rejected on a `"stub"` or `"search"` tool, alongside a `path` containing `"?"`, an undeclared
  `arg`, a duplicate `name`, and either half of an `omitWhen`/undefinedness mismatch — see the
  README for the full list. `discord` and `google-meet` are the two fixtures exercising it;
  neither reaches a byte-exact `src/server.ts`, for reasons unrelated to `query` itself — see
  `docs/ROADMAP.md`'s *Known limitations*. See **Breaking** below for the identifiers now
  reserved.

### Output changes (user-visible)

* **emit(server):** an `auth: "headers"` env entry that declares a **single** variable now
  returns its header object on one line. Regenerating an existing connector built with
  0.3.3 or earlier will therefore show a diff in `src/server.ts`:

  ```diff
  -  return {
  -    "X-Api-Key": k,
  -    Accept: "application/json",
  -  };
  +  return { "X-Api-Key": k, Accept: "application/json" };
  ```

  Semantically neutral — same object, same keys, same values — and it matches what every
  corpus connector with one custom header writes. An entry declaring two or more variables
  is unchanged and still expands. There is no spec field to opt out: the two forms are a
  formatting convention, not a behaviour, and carrying a switch for it would outlive its
  usefulness. A connector using `auth: "bearer"`, `auth: "basic"`, or `inlineHeaders` is
  unaffected.

### Breaking (spec validation)

* **validate:** eight identifiers are now reserved and a spec reusing one is rejected at parse
  time: `runReadOnlyMcpConnector`, `ZodToolRegistrar`, `searchToolInputSchema`, `matchesResult`,
  `McpListResult`, `ZodObjectSchema`, `SearchMatchOptions` and `root`. Each is a name the
  emitted `src/server.ts` declares or imports for the new `read-only-kit` style or a search
  tool, so reusing one previously emitted two declarations of it and failed the generated
  package's own `typecheck` — this moves that failure to parse time, where the error names the
  field. Reserved unconditionally, matching how `token` and `cachedToken` were handled in 0.3.0.

  **`root` is the one likely to affect an existing spec**, being an ordinary word: a search tool
  with `rows` emits `const root = await <fetchHelper.local>(…)`. Rename the `local`; nothing
  else changes.

* **validate:** eight more identifiers are reserved: `fieldsOf`, `asObjectish`, `stringField`,
  `nestedString`, `tagText`, `tagNamesFromObjects`, `makeQueryFilter` and `fieldsFromKeys`. The
  first six are declared or imported by the bespoke-extractor branch `filter.fields` can now
  reach (see Features, above); the last two were already emitted by the Stage D keyed-filter
  branch and simply never claimed until now. **`stringField` and `nestedString` are as ordinary
  as `root` was** — an env accessor or hoisted argument local carrying either name previously
  generated fine and now fails at parse time, naming the field.

* **validate:** every `filter.export` is now claimed against every other emitted identifier, so
  one colliding with the fetch helper, an env accessor, a hoisted argument local, or any
  reserved name is a parse-time error rather than two declarations of the same name in the
  generated package. This also closes a real bug: `filter.export: "makeQueryFilter"` previously
  emitted `export const makeQueryFilter = makeQueryFilter(...)`, a self-reference that failed
  the generated package's own typecheck.

* **spec:** three shapes that previously generated a broken or misleading package are now
  parse-time rejections. A `path` entry with fewer than two segments — a one-segment path emits
  the same call as the plain-string spelling, so accepting both is an ambiguity rather than a
  courtesy. Legacy `filter.tags: true` combined with a `fields` list that forces the extractor
  branch — the extractor never reads `tags`, so it was silently dropped: the tool compiled,
  passed every gate, and simply never matched on tags. And more than one search filter per
  connector taking the extractor branch — the emitted extractor is always named `fieldsOf`, so a
  second one is a duplicate declaration.

* **validate:** three more identifiers are reserved: `u`, `URL` and `url`. All three are names
  the new `query` feature's emitted handler binds itself: a tool declaring `query` emits
  `const u = new URL(<path>)` and calls the global `URL` directly, and every fetch helper — not
  only rest-kit's, which already declared it unconditionally before this change — now emits
  `const url = path.startsWith("http") ? path : ...` whenever the spec declares any query tool
  at all. Each is reserved unconditionally, matching how `token` and `root` were handled
  earlier: the list is checked before any style or tool kind is considered, so a conditional
  entry would mean a spec validating or failing depending on a field elsewhere in the file.

  **`u` and `url` are ordinary words, more so than `root` was.** A spec published against
  0.5.0 or earlier may already spell a `fetchHelper.local` `"u"`, an env `local` `"url"`, or a
  `fetchHelper.baseConst` `"url"` — none of those collided with anything before this release.
  Rename the field; nothing else changes. (`URL`, being a global identifier already reserved
  everywhere in this list's neighboring entries such as `fetch` and `JSON`, is the less likely
  of the three to be in use, but is reserved for the same reason.)

### Bug Fixes

* **emit(manifest):** a `filesystem` path containing `$&`, `` $` ``, `$'` or `$$` no longer
  corrupts `nimbus.extension.json`. The one-line collapse of `permissions.filesystem` passed
  its replacement to `String.prototype.replace` as a string, which expands those tokens; a
  path of `"$&BAD"` produced a manifest `JSON.parse` rejects, and `"A$$B"` was silently
  written as `"A$B"`. Only reachable from a spec that declares `permissions.filesystem`,
  which is new in this same unreleased range.

## [0.7.0](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.6.0...create-nimbus-connector-v0.7.0) (2026-08-04)


### Features

* **reach:** measure corpus regeneration coverage with its method ([#57](https://github.com/nimbus-agent/create-nimbus-connector/issues/57)) ([e64d777](https://github.com/nimbus-agent/create-nimbus-connector/commit/e64d7770f3311c75ce6ca97b61d1f945aee0767a))

## [0.6.0](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.5.0...create-nimbus-connector-v0.6.0) (2026-08-03)


### Features

* Stage E — conditional query parameters, and the corpus reach with its method ([#54](https://github.com/nimbus-agent/create-nimbus-connector/issues/54)) ([b635ec3](https://github.com/nimbus-agent/create-nimbus-connector/commit/b635ec3bb779589d2379416b903a47583c19333e))

## [0.5.0](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.4.0...create-nimbus-connector-v0.5.0) (2026-08-02)


### Features

* Stage E — path and tag entries in filter.fields ([#51](https://github.com/nimbus-agent/create-nimbus-connector/issues/51)) ([6864a4b](https://github.com/nimbus-agent/create-nimbus-connector/commit/6864a4b9c4a72eed14814ce021502fb9bf96664f))

## [0.4.0](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.3.3...create-nimbus-connector-v0.4.0) (2026-08-02)


### Features

* Stage D — the read-only-kit style and search tools ([#47](https://github.com/nimbus-agent/create-nimbus-connector/issues/47)) ([82e9508](https://github.com/nimbus-agent/create-nimbus-connector/commit/82e9508a6e108bf04ecccc0a34c819d197de3e80))

## [0.3.3](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.3.2...create-nimbus-connector-v0.3.3) (2026-08-01)


### Bug Fixes

* **golden:** clear 21 SonarCloud issues incl. the unsafe sort comparator ([#37](https://github.com/nimbus-agent/create-nimbus-connector/issues/37)) ([b89e9d9](https://github.com/nimbus-agent/create-nimbus-connector/commit/b89e9d9706b16421dc741f1cd64af304b1d983f8))

## [0.3.2](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.3.1...create-nimbus-connector-v0.3.2) (2026-08-01)


### Bug Fixes

* **cli:** --version, flag suggestions, and a checkout test for --gateway-wiring ([#31](https://github.com/nimbus-agent/create-nimbus-connector/issues/31)) ([af93ffc](https://github.com/nimbus-agent/create-nimbus-connector/commit/af93ffcf09b1a7b1ab4dd5eb21de6a31b7b2494a))
* **prompts:** validate each answer where it is given ([#33](https://github.com/nimbus-agent/create-nimbus-connector/issues/33)) ([444b009](https://github.com/nimbus-agent/create-nimbus-connector/commit/444b0092e1c5e5e05e5a099dc60e173db5626755))

## [0.3.1](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.3.0...create-nimbus-connector-v0.3.1) (2026-08-01)


### Bug Fixes

* **cli:** reject {id} and /:id path templates, and add --help ([#27](https://github.com/nimbus-agent/create-nimbus-connector/issues/27)) ([858ef62](https://github.com/nimbus-agent/create-nimbus-connector/commit/858ef62b2b0a05969c38012061165d4220784341))

## [0.3.0](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.2.2...create-nimbus-connector-v0.3.0) (2026-08-01)


### Features

* Stage C — write tools, hitlRequired, client-credentials OAuth, Gateway wiring ([#23](https://github.com/nimbus-agent/create-nimbus-connector/issues/23)) ([0a122aa](https://github.com/nimbus-agent/create-nimbus-connector/commit/0a122aa13a81bd5dd016dd9beedd4ccde5d77f4a))

## [0.2.2](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.2.1...create-nimbus-connector-v0.2.2) (2026-07-31)


### Bug Fixes

* address SonarCloud findings ([#18](https://github.com/nimbus-agent/create-nimbus-connector/issues/18)) ([4ddb372](https://github.com/nimbus-agent/create-nimbus-connector/commit/4ddb372012c7c255354b300bee31b696841c82d3))

## [0.2.1](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.2.0...create-nimbus-connector-v0.2.1) (2026-07-31)


### Bug Fixes

* **dependabot:** use the bun ecosystem, not npm ([#15](https://github.com/nimbus-agent/create-nimbus-connector/issues/15)) ([46ab544](https://github.com/nimbus-agent/create-nimbus-connector/commit/46ab544ebb24b383b02809be92b680289cbfc1a5))

## [0.2.0](https://github.com/nimbus-agent/create-nimbus-connector/compare/create-nimbus-connector-v0.1.0...create-nimbus-connector-v0.2.0) (2026-07-31)


### Features

* acceptance harness with guaranteed monorepo cleanup ([78fe166](https://github.com/nimbus-agent/create-nimbus-connector/commit/78fe166d74d41c251bfd7c30a3d1de794e628709))
* **cli:** --license &lt;spdx&gt;, and stop stamping standalone packages AGPL ([608617b](https://github.com/nimbus-agent/create-nimbus-connector/commit/608617b9ebe9765f9b6bac2e8f72d43838699137))
* **cli:** --standalone flag and standalone default out-dir ([be646db](https://github.com/nimbus-agent/create-nimbus-connector/commit/be646dba5f2cbd86614a011fbf3a78cc17cd7df7))
* **cli:** interactive prompts, --spec and --dry-run ([6c2463c](https://github.com/nimbus-agent/create-nimbus-connector/commit/6c2463c904fb6f0746911d625f3aa23caecb31e8))
* create-nimbus-connector — monorepo and standalone connector scaffolding ([d13de0b](https://github.com/nimbus-agent/create-nimbus-connector/commit/d13de0bbf07f63f961506f601d95aa6f9e591d0c))
* **emit:** add generate target, emitting the published kit for standalone ([0ba4686](https://github.com/nimbus-agent/create-nimbus-connector/commit/0ba4686c262eb278da421492321279d32e2806ef))
* **emit:** compose server.ts and the generate() entry point ([a0616cf](https://github.com/nimbus-agent/create-nimbus-connector/commit/a0616cf1ccf9ce80ca25c2f07dacda145c480677))
* **emit:** env accessor emitter with fixed transform pipeline ([afe5eea](https://github.com/nimbus-agent/create-nimbus-connector/commit/afe5eea6ba982d5735201b47d13cb8a6173d47ce))
* **emit:** fetch helper emitter with explicit object expansion ([c05744e](https://github.com/nimbus-agent/create-nimbus-connector/commit/c05744ea77b7a54528bc330cf4a1b7d8d9ba7f4e))
* **emit:** hand-rolled style tool registrations ([0d2230b](https://github.com/nimbus-agent/create-nimbus-connector/commit/0d2230b2483f28c9ddb742475190f94f1907dce6))
* **emit:** manifest and README emitters ([2fc19f8](https://github.com/nimbus-agent/create-nimbus-connector/commit/2fc19f814bb3f4cc3fadf514c6d23957687eb754))
* **emit:** package.json, tsconfig and sandbox test emitters ([a32bda5](https://github.com/nimbus-agent/create-nimbus-connector/commit/a32bda5ca703c5556307756689b10b32e6577a39))
* **emit:** path template parser and renderer ([b60abbf](https://github.com/nimbus-agent/create-nimbus-connector/commit/b60abbf1123ea3184c824eef7d5d886b113b09fb))
* **emit:** rest-tool-kit style tool registrations ([ce027bb](https://github.com/nimbus-agent/create-nimbus-connector/commit/ce027bbb70e14b32c594a7a7fa2ed1464af07da0))
* **emit:** standalone package.json, tsconfig and README ([8f82430](https://github.com/nimbus-agent/create-nimbus-connector/commit/8f82430fa3de1a6e396742c9f7f7451a96381362))
* **emit:** zod schema and hoist rendering for tool arguments ([2127cc6](https://github.com/nimbus-agent/create-nimbus-connector/commit/2127cc65539cb4375283de2f285c406e7694632d))
* **format:** in-process Biome WASM formatting ([44d9111](https://github.com/nimbus-agent/create-nimbus-connector/commit/44d9111ebfd6623e88d4498e564bde9ea4dd9706))
* **format:** make Biome optional via initFormatter, keeping formatAll sync ([7f3a9f5](https://github.com/nimbus-agent/create-nimbus-connector/commit/7f3a9f53d258aac4ca599bb7a15e454b0ac3da20))
* **golden:** datadog, grafana and sentry fixtures at zero diff ([a10e2d2](https://github.com/nimbus-agent/create-nimbus-connector/commit/a10e2d255230c701bf386b7600d4ddb48a779da2))
* **golden:** diff harness and newrelic fixture at zero diff ([c73257a](https://github.com/nimbus-agent/create-nimbus-connector/commit/c73257a70e4b8c19faea483e1f3c9d241e0b3cab))
* **golden:** expectation tracking for fixture identical-file counts ([1b4111c](https://github.com/nimbus-agent/create-nimbus-connector/commit/1b4111cdc211217b1234c96ca5777965808258af))
* **golden:** style R fixtures with documented coverage gaps ([2ced617](https://github.com/nimbus-agent/create-nimbus-connector/commit/2ced61724aabeb8d438e6d97b1db1c2ea4bf55bc))
* project scaffolding and GeneratedFile type ([afc1e78](https://github.com/nimbus-agent/create-nimbus-connector/commit/afc1e782f2f06593ffa326dab36fcad15b5b9496))
* publishing metadata and Stage B acceptance results ([8a9dcee](https://github.com/nimbus-agent/create-nimbus-connector/commit/8a9dcee7d7083a3dc1103b579fa03ef5bbbbfc10))
* **spec:** strict ConnectorSpec schema with derived defaults ([d01f6ac](https://github.com/nimbus-agent/create-nimbus-connector/commit/d01f6ace6b51e5db6502e51106cc828722b6e46b))
* **standalone:** --registry mode, and correct the now-stale SDK claims ([285e897](https://github.com/nimbus-agent/create-nimbus-connector/commit/285e897d0ba812affb9b9e3a9cd13196104af6e5))
* **standalone:** sdk-root resolver and live stdio acceptance harness ([392c82c](https://github.com/nimbus-agent/create-nimbus-connector/commit/392c82c70bccc442ab30602bb6319284c1234381))
* **validate:** flat identifier-uniqueness check ([d9814a8](https://github.com/nimbus-agent/create-nimbus-connector/commit/d9814a8a6da95d0caa1c9cad3f2a50a7a31198d5))


### Bug Fixes

* **cli:** reject malformed flags/combos, wrap errors cleanly ([d34c250](https://github.com/nimbus-agent/create-nimbus-connector/commit/d34c250f478bfa44f3c5ae3292f31905e7ec7804))
* consolidated pre-merge review fixes (F1,F2,F3,F5,F6,F7,F8,F11,F12,F13a) ([6846894](https://github.com/nimbus-agent/create-nimbus-connector/commit/684689423be1ecd6fc6f69b40718b928315f1aaa))
* **docs:** correct the last two dist-resolution claims, and accept --sdk-root ([dd0738a](https://github.com/nimbus-agent/create-nimbus-connector/commit/dd0738af44f870da25ff6d44c0e3dd63ea6302a1))
* **docs:** scope dist-resolution claims to typecheck/existence, not bun-spawned runtime ([70945df](https://github.com/nimbus-agent/create-nimbus-connector/commit/70945df6accb69defcc4b0f93850c63b4436cfbe))
* drop the leading ./ from the bin path ([789eacf](https://github.com/nimbus-agent/create-nimbus-connector/commit/789eacf5bac392bdfa2fb407246195c76d478130))
* drop the leading ./ from the bin path ([de1e1d1](https://github.com/nimbus-agent/create-nimbus-connector/commit/de1e1d1e39997f8552e2e722891fb50e462b704b))
* **emit:** add malformed placeholder validation to path-template parser ([7b50588](https://github.com/nimbus-agent/create-nimbus-connector/commit/7b50588ddf198b8df57f1d68d3842c43bbceea5e))
* **emit:** correct sandbox test and import specifier checks ([b710fbd](https://github.com/nimbus-agent/create-nimbus-connector/commit/b710fbdb43aeb6d6d0f348123adfe78d53ef6e28))
* **emit:** omit unused handler parameter in hand-rolled tools ([e761351](https://github.com/nimbus-agent/create-nimbus-connector/commit/e76135144e88dc2815abdd4a9fa5015781ed84a8))
* **format:** distinguish an absent optional dependency from a broken one ([89eebd9](https://github.com/nimbus-agent/create-nimbus-connector/commit/89eebd9aa9d185211bdd3dad7ee4f8e9b7a69388))
* **format:** format emitted JSON through Biome, not just TypeScript ([e6dc645](https://github.com/nimbus-agent/create-nimbus-connector/commit/e6dc64544ab6b85ff4fb4235ec6142b4a2c2670a))
* **format:** narrow initFormatter's try to the dynamic import only ([92b41a9](https://github.com/nimbus-agent/create-nimbus-connector/commit/92b41a9ce9cdac856df6b7803cc22919033ffdc5))
* **format:** validate Biome diagnostics and throw on parse errors ([0e56925](https://github.com/nimbus-agent/create-nimbus-connector/commit/0e5692596c19f8514c6234d6d4ea6d92c113c920))
* **golden:** compare which files matched, not how many ([c6b6542](https://github.com/nimbus-agent/create-nimbus-connector/commit/c6b65420ca1442f075d2a67b120138395de939df))
* **golden:** reject empty/unknown fixture selections; make resolver test hermetic ([d78923d](https://github.com/nimbus-agent/create-nimbus-connector/commit/d78923db4a9f30a39b0da8db6d85d54a41d5f378))
* **scripts:** replace grep spawn with pure-Bun scan in standalone-acceptance ([1dc313c](https://github.com/nimbus-agent/create-nimbus-connector/commit/1dc313c213c64839896e595d2188baf6be0ba013))
* **spec,emit:** reject undefined env-accessor calls in rest-kit fetchHelper; drop unused imports ([fec793d](https://github.com/nimbus-agent/create-nimbus-connector/commit/fec793d8f9a926aebbd8b55d75b1fe1543b9b50a))
* **spec:** add EnvSchema refinements for auth and multi-var constraints ([500fc8b](https://github.com/nimbus-agent/create-nimbus-connector/commit/500fc8bc164f7b907bcfda66b9c9c3088ffa9486))
* **spec:** enforce rest-kit env validation and update tests ([b358a61](https://github.com/nimbus-agent/create-nimbus-connector/commit/b358a6142e3f5fa198801b42bf1bbcc3ad4d941c))
* **spec:** reject rest-kit fetchHelper fields the emitter would silently drop ([ce671b9](https://github.com/nimbus-agent/create-nimbus-connector/commit/ce671b97dd5ba93ca11e5cfc74da041c37237e40))
* **spec:** satisfy biome lint (no-non-null-assertion, template-curly false positive) ([ea69091](https://github.com/nimbus-agent/create-nimbus-connector/commit/ea690912d18b792653273c50de3ae2db773df630))
* **spec:** use record-key regex for better arg-name diagnostics ([d81a381](https://github.com/nimbus-agent/create-nimbus-connector/commit/d81a381968c80d00f64fabbab10fa6d61ed286e0))
* **spec:** validate argument names, boolean defaults, and type constraints ([65f34f3](https://github.com/nimbus-agent/create-nimbus-connector/commit/65f34f30b0c641a78902a1af06e526c6334122f9))
* **standalone:** also drive tools/list against the built dist/server.js ([2935a93](https://github.com/nimbus-agent/create-nimbus-connector/commit/2935a93fdf655ca30538885299efbb0504dfc2fb))
* **standalone:** drop the empty credentials fence, and ignore generated output ([4eb457d](https://github.com/nimbus-agent/create-nimbus-connector/commit/4eb457d5fb748ae6c6348465fc035c8605e36ead))
* **standalone:** make generated packages pass their own lint and typecheck ([64ed8cd](https://github.com/nimbus-agent/create-nimbus-connector/commit/64ed8cd45946f7ccd8d2678fe7cebf225e92da83))
* **validate:** add registrar identifier to flat namespace check ([fb08186](https://github.com/nimbus-agent/create-nimbus-connector/commit/fb08186d96c4b92d39cc9df80ec95f7ba48f2eb2))
