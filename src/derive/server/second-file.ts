/**
 * The shim connector: a `src/server.ts` whose every tool is registered from `./tools.ts`.
 *
 * The frame is already well-formed — `recognizeFrame` succeeds for all of these — so nothing here
 * touches frame recognition. What is missing is the registrations themselves: the module's only
 * tool statement is a call to a name imported from a second file, which no tool recognizer reads.
 *
 * This applies the SAME splice `recognizeReadOnlyFrame` applies one file over: the container is
 * removed from what the totality rule walks and replaced by its body, and it is never CLAIMED.
 * Claiming it would be retroactive over every registration nested inside — see that function's
 * docstring for why that is the hazard rather than the shortcut.
 *
 * **`tools.ts`'s other module-scope statements are not free.** They travel back as
 * `ForeignStatements` and the totality rule walks them exactly as it walks `server.ts`'s. Its
 * imports, helper functions and type declarations are blockers unless a recognizer claims them,
 * identically to how they would be blockers had the connector written them inline. Skipping them
 * would let a connector with an unrecognizable helper derive successfully, which is the precise
 * false `emits` the totality rule exists to prevent.
 */

import { type AstNode, parseModule } from "../ast.ts";
import { type ClaimSet, createClaimSet } from "../claims.ts";
import {
  calleeOf,
  constDecl,
  exportedDeclaration,
  expressionOf,
  functionName,
  identName,
  importNames,
  importSource,
  isTypeOnlyImport,
} from "../read.ts";
import type { Frame } from "./frame.ts";
import { namedRegistrarBody } from "./index.ts";

/** Statements from a file other than `src/server.ts`, with the text they were parsed from. */
export type ForeignStatements = {
  readonly file: string;
  readonly source: string;
  readonly statements: readonly AstNode[];
};

export type SecondFileSplice = {
  readonly frame: Frame;
  readonly foreign: ForeignStatements;
  /** `tools.ts`'s OWN claim set — see `applySecondFile`. Never the server's. */
  readonly foreignClaims: ClaimSet;
};

/**
 * Why a shim's second file could not be spliced. `"not-a-shim"` is the inert case — the server
 * is not the shim pair at all, so supplying `tools` for it changes nothing. Every OTHER value
 * means we tried to read the file and could not, which is a different fact from never having
 * looked and must not be reported as though it were.
 */
export type SecondFileRefusal =
  | "not-a-shim"
  | "unparseable"
  | "no-matching-export"
  | "registrar-not-a-declaration"
  | "duplicate-export";

export type SecondFileResult = SecondFileSplice | { readonly refused: SecondFileRefusal };

/** The one tool statement that is a bare call, and the name it calls. */
function loneCallName(statements: readonly AstNode[]): { node: AstNode; name: string } | undefined {
  if (statements.length !== 1) return undefined;
  const node = statements[0];
  if (node === undefined) return undefined;
  const name = identName(calleeOf(expressionOf(node)));
  return name === undefined ? undefined : { node, name };
}

/**
 * The module specifier of `node`, when `node` is a `./…`-relative import whose own specifiers bind
 * `name` — otherwise undefined.
 *
 * Exported because `collapseSecondFileBlockers` (src/derive/index.ts) asks the identical question
 * of the shim's two unclaimed statements, and the two copies of it agreed only by coincidence: the
 * same drift shape the `namedRegistrarBody` export was made to avoid, one file over. What the two
 * call sites legitimately differ in is how they LOCATE the candidate — a two-element unclaimed
 * array there, `frame.verifyStatements` here — so only this predicate is shared, not the search.
 *
 * The source is returned rather than a boolean because the blocker's detail quotes it, and a caller
 * that had to re-read it would be re-asserting half the predicate to get it.
 *
 * importNames returns undefined for a default or namespace clause, so `import tools from` and
 * `import * as tools from` fall through here rather than needing a rule of their own. The match is
 * on `local`, the binding the call site actually uses, so a renamed import works.
 */
export function relativeImportBindingSource(
  node: AstNode | undefined,
  name: string,
): string | undefined {
  const source = importSource(node);
  if (source?.startsWith("./") !== true) return undefined;
  return importNames(node)?.some((n) => n.local === name) === true ? source : undefined;
}

/** The `./…`-relative import whose specifiers bind `name`. */
function relativeImportBinding(statements: readonly AstNode[], name: string): AstNode | undefined {
  return statements.find((s) => relativeImportBindingSource(s, name) !== undefined);
}

/**
 * Whether `tools.ts` exports a binding under `name` at all — used ONLY to tell two refusals apart.
 *
 * Both spellings are needed and neither is optional. `functionName` sees
 * `export function registerXTools(...)` that `namedRegistrarBody` rejected for its signature;
 * `constDecl` sees `export const registerXTools = (reg) => {}`, the arrow-bound form, which is the
 * whole reason `registrar-not-a-declaration` exists as a distinct refusal. Reading only the first
 * would report the arrow case as `no-matching-export` — a wrong label on the exact shape the
 * measurement most wants counted.
 */
function exportsName(statements: readonly AstNode[], name: string): boolean {
  return statements.some((s) => {
    const decl = exportedDeclaration(s);
    return functionName(decl) === name || constDecl(decl)?.name === name;
  });
}

/**
 * Whether an import contributes no value binding — `import type { X } from "…"` or
 * `import { type X } from "…"`, the two spellings TypeScript accepts for the same thing.
 *
 * Both are read, because `importNames`' `isType` answers only for the second (see
 * `isTypeOnlyImport` in read.ts: Babel marks the declaration for one spelling and the specifier
 * for the other, never both). Reading one alone would leave every shim blocking on its own
 * `import type { ZodToolRegistrar }`, which is the noise this claim exists to remove.
 *
 * An empty clause (`import "./side-effect.ts"`) is deliberately NOT type-only: it runs code.
 */
function isValueFreeImport(node: AstNode): boolean {
  const names = importNames(node);
  if (names === undefined || names.length === 0) return false;
  return isTypeOnlyImport(node) || names.every((n) => n.isType);
}

export function applySecondFile(
  frame: Frame,
  claims: ClaimSet,
  toolsSource: string,
): SecondFileResult {
  const call = loneCallName(frame.toolStatements);
  if (call === undefined) return { refused: "not-a-shim" };

  const imported = relativeImportBinding(frame.verifyStatements, call.name);
  if (imported === undefined) return { refused: "not-a-shim" };

  let toolsStatements: AstNode[];
  try {
    toolsStatements = parseModule(toolsSource);
  } catch {
    // Distinguished from "not-a-shim" deliberately. An empty file lands here too — it parses to
    // zero statements and falls through to no-matching-export, which is the honest label for it.
    return { refused: "unparseable" };
  }

  let declaration: AstNode | undefined;
  let body: readonly AstNode[] | undefined;
  for (const statement of toolsStatements) {
    const match = namedRegistrarBody(statement, call.name);
    if (match === undefined) continue;
    // Two declarations of one name is a shape no module writes and TypeScript rejects; refuse
    // rather than pick, matching namedReadOnlyEntry's own duplicate rule.
    if (declaration !== undefined) return { refused: "duplicate-export" };
    declaration = statement;
    body = match;
  }
  if (declaration === undefined || body === undefined) {
    // The two are worth telling apart, and this is the whole reason refusals are typed: "the file
    // has no such export" and "it has one, in a shape this matcher does not accept" point at
    // completely different work. The second is the arrow-bound registrar, and how many connectors
    // write it is a number the histogram wants.
    return {
      refused: exportsName(toolsStatements, call.name)
        ? "registrar-not-a-declaration"
        : "no-matching-export",
    };
  }

  // The import is genuinely accounted for: it exists to bind the registrar whose body is now
  // spliced in. Claiming it is correct and is NOT the retroactive-claim hazard — an import
  // declaration nests no registration. This is the ONE node this function claims in the server's
  // set, and it really is a `src/server.ts` node.
  claims.claim(imported, "the second file's tools import");

  // tools.ts gets its OWN claim set. Claims are byte ranges and `covers` is containment, so a
  // tools.ts node checked against the server's set is asking whether its offsets sit inside a
  // range claimed in a different file — which for two files both starting at offset 0 is a
  // coincidence, not a fact. Sharing the set would mark foreign statements claimed and produce
  // the false `emits` the totality rule exists to prevent.
  const foreignClaims = createClaimSet();

  // The registrar declaration is spliced, never claimed — the same rule as the read-only wrapper,
  // for the same reason: a claim would be retroactive over every registration inside it.
  const rest = toolsStatements.filter((s) => s !== declaration);

  // The type-only imports the registrar's own signature needs, claimed so the histogram measures
  // what the connector DOES rather than what TypeScript required it to write. Nothing else is
  // claimed here: a value import, a helper function, a hoisted const and a local type alias all
  // stay unclaimed and become blockers, exactly as they would had the connector written them in
  // src/server.ts. Widening this list is how a false `emits` gets in.
  for (const statement of rest) {
    if (isValueFreeImport(statement)) {
      foreignClaims.claim(statement, "a type-only import the second file's registrar needs");
    }
  }

  return {
    frame: {
      ...frame,
      toolStatements: body,
      // The shim's call is spliced OUT, exactly as the read-only wrapper is: replaced by the body,
      // never marked claimed.
      verifyStatements: frame.verifyStatements.filter((s) => s !== call.node),
    },
    foreign: { file: "src/tools.ts", source: toolsSource, statements: rest },
    foreignClaims,
  };
}
