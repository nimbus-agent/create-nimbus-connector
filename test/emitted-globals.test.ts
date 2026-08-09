import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { generate } from "../src/emit/index.ts";
import { emitWiring } from "../src/emit/wiring.ts";
import { formatAll, initFormatter } from "../src/format.ts";
import { type ConnectorSpec, parseSpec } from "../src/spec.ts";
import { RESERVED_IDENTIFIERS } from "../src/validate.ts";

/**
 * Every name the emitted code reads without declaring it — its FREE identifiers — checked
 * against `RESERVED_IDENTIFIERS`.
 *
 * That list is the standing rule CLAUDE.md states: an emitter that declares or imports a new
 * module-scope name adds it here in the same change. It had been kept by hand, and it had
 * drifted: `fetch`, `process`, `JSON`, `String`, `Error` and `URLSearchParams` were listed while
 * `Date`, `Math` and `Number` — which the token exchange calls on the same lines — were not, and
 * neither was `undefined`, which every guard in every branch compares against. Three waves of
 * that mistake are on the record before this one.
 *
 * A test enumerating the missing names would be the fourth. This one asks the emitters instead:
 * it generates every fixture for both targets, adds the Gateway wiring and the branch shapes no
 * fixture reaches, parses each emitted `.ts` file, and subtracts every binding the module
 * introduces from every identifier it references. What is left is what the module expects the
 * runtime to supply, and it has to be accounted for.
 *
 * `@babel/parser` is an optionalDependency, imported statically here because `bun install`
 * installs it and `src/derive/` cannot work without it — the same assumption
 * test/derive/ast.test.ts already makes ("@babel/parser cannot be made unresolvable in-process
 * in a repo that has it").
 */

const FIXTURES = join(import.meta.dir, "..", "fixtures");

/* eslint-disable-next-line -- structural walk over Babel nodes, which are untyped here. */
type Node = Record<string, unknown> & { type: string };

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

/** Every name a binding pattern introduces. */
function collectPattern(pattern: unknown, out: Set<string>): void {
  if (!isNode(pattern)) return;
  switch (pattern.type) {
    case "Identifier":
      out.add(pattern["name"] as string);
      return;
    case "ObjectPattern":
      for (const p of pattern["properties"] as unknown[]) {
        const prop = p as Record<string, unknown>;
        collectPattern(prop["value"] ?? prop["argument"], out);
      }
      return;
    case "ArrayPattern":
      for (const e of pattern["elements"] as unknown[]) collectPattern(e, out);
      return;
    case "AssignmentPattern":
      collectPattern(pattern["left"], out);
      return;
    case "RestElement":
      collectPattern(pattern["argument"], out);
      return;
    default:
      return;
  }
}

/** Signatures whose parameter names are bindings even though nothing is executed. */
const PARAMETERISED = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "TSDeclareFunction",
  "TSFunctionType",
  "TSMethodSignature",
  "TSConstructorType",
  "TSCallSignatureDeclaration",
]);

/**
 * Identifiers referenced but never bound, in one module.
 *
 * Over-approximates by design: a construct the walk does not model leaks an extra name into the
 * result, which FAILS the assertion below rather than quietly shrinking it. The first draft
 * leaked six — a type parameter and five names from a function-TYPE signature's parameter list —
 * and that is exactly how it was found.
 */
function freeIdentifiers(source: string): Set<string> {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const bound = new Set<string>();
  const referenced = new Set<string>();

  const walk = (node: unknown, parentType: string | undefined, key: string): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parentType, key);
      return;
    }
    if (!isNode(node)) return;

    switch (node.type) {
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        collectPattern(node["local"], bound);
        break;
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "TSDeclareFunction":
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
      case "TSEnumDeclaration":
        collectPattern(node["id"], bound);
        break;
      case "TSTypeParameter": {
        // Babel spells this as a bare string in some versions and an Identifier node in others.
        const name = node["name"];
        if (typeof name === "string") bound.add(name);
        else collectPattern(name, bound);
        break;
      }
      case "VariableDeclarator":
        collectPattern(node["id"], bound);
        break;
      case "CatchClause":
        collectPattern(node["param"], bound);
        break;
      case "TSTypeReference": {
        // The head of `A.B.C` is the binding; the rest are property lookups on it.
        let head: unknown = node["typeName"];
        while (isNode(head) && head.type === "TSQualifiedName") head = head["left"];
        if (isNode(head) && head.type === "Identifier") referenced.add(head["name"] as string);
        break;
      }
      default:
        break;
    }
    if (PARAMETERISED.has(node.type)) {
      for (const p of (node["params"] ?? []) as unknown[]) collectPattern(p, bound);
    }
    if (node.type === "Identifier" && isReference(parentType, key)) {
      referenced.add(node["name"] as string);
    }

    for (const [childKey, child] of Object.entries(node)) {
      if (childKey === "loc" || childKey === "start" || childKey === "end") continue;
      if (childKey.endsWith("Comments")) continue;
      walk(child, node.type, childKey);
    }
  };

  walk(ast.program, undefined, "program");
  return new Set([...referenced].filter((name) => !bound.has(name)));
}

/**
 * Whether an `Identifier` in this position is a VALUE reference rather than a name being written
 * down. Property keys, non-computed member properties and import/export specifier names all spell
 * an identifier that resolves to nothing in scope.
 */
function isReference(parentType: string | undefined, key: string): boolean {
  if (parentType === undefined) return false;
  // `import.meta.url`, which the emitted test/sandbox.test.ts uses to locate the manifest. Babel
  // spells the `import` half as an Identifier under a MetaProperty; it names no binding.
  if (parentType === "MetaProperty") return false;
  if (key === "key" || key === "property" || key === "imported" || key === "exported") return false;
  if (key === "id" || key === "local" || key === "param" || key === "params") return false;
  if (key === "typeName" || key === "label") return false;
  return true;
}

/**
 * Branch shapes the fixture corpus never reaches, so the scan sees every emitter path rather
 * than only the ones a byte-locked fixture happens to use. `zzwrite` is the only fixture with
 * `auth: "client-credentials"` and it is `credentialsIn: "basic"`, so the `body` arm and `scope`
 * are added here; no fixture combines `trimTrailingSlashFn` with a two-var `auth: "headers"`.
 */
const SYNTHETIC: readonly (readonly [string, unknown])[] = [
  [
    "client-credentials, body + scope",
    {
      name: "zzcc",
      displayName: "Zz CC",
      description: "Probe connector.",
      serviceLabel: "ZzCC",
      style: "hand-rolled",
      env: [
        {
          vars: ["ZZ_ID", "ZZ_SECRET"],
          local: "authHeaders",
          auth: "client-credentials",
          tokenUrl: "https://t.test/token",
          credentialsIn: "body",
          scope: "read write",
        },
      ],
      fetchHelper: { local: "zzGet", base: "https://api.test", headers: "authHeaders" },
      tools: [{ name: "zzcc_get", description: "Get.", path: "/v1/things" }],
    },
  ],
  [
    "trimTrailingSlashFn + two-var header auth",
    {
      name: "zztt",
      displayName: "Zz TT",
      description: "Probe connector.",
      serviceLabel: "ZzTT",
      style: "hand-rolled",
      env: [
        { vars: ["ZZ_URL"], local: "apiRoot", required: true, transform: "trimTrailingSlashFn" },
        {
          vars: ["ZZ_K1", "ZZ_K2"],
          local: "authHeaders",
          auth: "headers",
          headerNames: ["X-A", "X-B"],
        },
      ],
      fetchHelper: {
        local: "zzGet",
        base: "https://${env.apiRoot}",
        headers: "authHeaders",
      },
      tools: [{ name: "zztt_get", description: "Get.", path: "/v1/things" }],
    },
  ],
];

/**
 * Free names that are not collisions, each with the measurement that says so. One entry, and it
 * may not grow without one.
 */
const NOT_A_COLLISION: Record<string, string> = {
  Record:
    "a type-space name only. `function Record(): Record<string, string>` declares a value and " +
    "resolves the annotation in the other namespace — compiled clean under --strict, the same " +
    "check that showed three of validateTitleIdentifier's four positions were fine.",
};

let sources: { readonly label: string; readonly free: ReadonlySet<string> }[] = [];

beforeAll(async () => {
  await initFormatter();
  const documents: (readonly [string, unknown])[] = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".spec.json"))
    .map((f) => [f, JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as unknown] as const);

  const out: { label: string; free: ReadonlySet<string> }[] = [];
  for (const [label, doc] of [...documents, ...SYNTHETIC]) {
    const spec: ConnectorSpec = parseSpec(doc);
    for (const target of ["monorepo", "standalone"] as const) {
      const files = formatAll(generate(spec, { target }));
      const wiring = spec.tools.some((t) => t.name.endsWith("_list"))
        ? formatAll(emitWiring(spec))
        : [];
      for (const file of [...files, ...wiring]) {
        if (!file.path.at(-1)!.endsWith(".ts")) continue;
        out.push({
          label: `${label} ${target} ${file.path.join("/")}`,
          free: freeIdentifiers(file.content),
        });
      }
    }
  }
  sources = out;
});

describe("every global the emitted code reads is accounted for", () => {
  it("scans enough emitted TypeScript to be worth trusting", () => {
    expect(sources.length).toBeGreaterThan(80);
    // The scan reports nothing if the walk breaks, and nothing would pass the subset assertion
    // below vacuously. These are the names it must find in SOME emitted file.
    const everything = new Set(sources.flatMap((s) => [...s.free]));
    for (const name of ["process", "fetch", "JSON", "Date", "Math", "Number", "undefined"]) {
      expect(everything).toContain(name);
    }
  });

  it("finds no free name that is neither reserved nor measured harmless", () => {
    const reserved = new Set(RESERVED_IDENTIFIERS);
    const unaccounted = new Map<string, string>();
    for (const { label, free } of sources) {
      for (const name of free) {
        if (reserved.has(name) || Object.hasOwn(NOT_A_COLLISION, name)) continue;
        if (!unaccounted.has(name)) unaccounted.set(name, label);
      }
    }
    expect([...unaccounted].map(([n, where]) => `${n} (first in ${where})`)).toEqual([]);
  });
});
