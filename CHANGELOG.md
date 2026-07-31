# Changelog

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
