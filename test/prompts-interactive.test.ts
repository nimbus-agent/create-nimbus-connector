/**
 * The interactive path, driven the way a user drives it: by piping answers to the real
 * binary.
 *
 * This is `npx create-nimbus-connector` with no arguments — the default entry point, and
 * the least-covered code in the repo, because Bun's coverage cannot see a child process
 * (which is also why src/prompts.ts is excluded from the coverage metric in bunfig.toml).
 * Spawning is the honest test for a flow whose whole behaviour is reading stdin.
 *
 * Every case below is a real failure a first-time user hits, and each one used to end in a
 * schema dump listing several errors at once, after the last question, with nothing pointing
 * at the answer that caused them.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tempDirs } from "./support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

function runInteractive(stdin: string): { exitCode: number; output: string } {
  const dir = tmp.make("cnc-prompt-");
  const r = Bun.spawnSync([process.execPath, cliPath, "--dry-run"], {
    cwd: dir,
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode,
    output: `${r.stdout.toString()}${r.stderr.toString()}`,
  };
}

/** Name, then eight blank lines to accept every remaining default. */
const acceptDefaults = (name: string) => `${name}\n\n\n\n\n\n\n\n`;

describe("interactive prompts", () => {
  it("accepts a valid name and every default", () => {
    const { exitCode, output } = runInteractive(acceptDefaults("acme-crm"));
    expect(exitCode).toBe(0);
    expect(output).toContain("nimbus.extension.json");
    expect(output).not.toContain("Invalid connector spec");
  });

  it("rejects a bad name at the prompt, not four errors later", () => {
    const { exitCode, output } = runInteractive("Acme CRM\nAcme CRM\nAcme CRM\n");
    expect(exitCode).toBe(1);
    expect(output).toContain("is not lower-kebab-case");
    // The old behaviour: every later default derived from the bad name, then a schema dump
    // naming four fields at once, none of which was the question the user got wrong.
    expect(output).not.toContain("Invalid connector spec");
  });

  it("rejects an unrecognised auth type instead of silently using bearer", () => {
    // The silent-coercion bug: normalizeAuthKind returned "bearer" for anything it did not
    // recognise, so this session used to SUCCEED and emit a bearer connector, discarding
    // the answer without a word.
    const { exitCode, output } = runInteractive("acme-crm\n\n\n\n\noauth\noauth\noauth\n");
    expect(exitCode).toBe(1);
    expect(output).toContain("is not one of: bearer, token, basic");
  });

  it("rejects a base URL with no scheme", () => {
    const { exitCode, output } = runInteractive(
      "acme-crm\n\n\n\napi.acme.com\napi.acme.com\napi.acme.com\n",
    );
    expect(exitCode).toBe(1);
    expect(output).toContain("is not a URL");
  });

  it("gives up after a bounded number of attempts rather than looping forever", () => {
    // Bun's prompt() returns the default on EOF, so an unbounded re-prompt would spin
    // forever on piped stdin — in exactly the situation where nobody is watching. The
    // failure message points at the escape hatch.
    const { exitCode, output } = runInteractive("");
    expect(exitCode).toBe(1);
    expect(output).toContain("no valid answer after 3 attempts");
    expect(output).toContain("--spec");
  });

  it("takes the name from argv and does not ask for it again", () => {
    const dir = tmp.make("cnc-prompt-");
    const r = Bun.spawnSync([process.execPath, cliPath, "acme-crm", "--dry-run"], {
      cwd: dir,
      stdin: Buffer.from("\n\n\n\n\n\n\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(r.exitCode).toBe(0);
    expect(output).not.toContain("Connector name");
  });
});
