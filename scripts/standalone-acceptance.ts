import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFiles } from "../src/cli.ts";
import { generate } from "../src/emit/index.ts";
import { formatAll, formatterAvailable, initFormatter } from "../src/format.ts";
import { run } from "../src/golden/run.ts";
import { resolveSdkRoot } from "../src/golden/sdk-root.ts";
import { parseSpec } from "../src/spec.ts";

const NAME = "zzstandalone";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolveSdkRoot({
  flag: process.argv[2],
  env: process.env["NIMBUS_SDK_ROOT"],
  scriptDir,
});
const sdkPkg = join(sdkRoot, "sdks", "typescript");

// A file: dependency installs BUILT output, which is what makes step 3 exercise
// the same dist resolution a real npm consumer takes.
if (!existsSync(join(sdkPkg, "dist", "connector-kit", "index.js"))) {
  throw new Error(
    `${sdkPkg}/dist/connector-kit/index.js is missing — run \`bun run build\` in the SDK first. ` +
      "A file: dependency installs dist, not src, so an unbuilt SDK cannot be verified here.",
  );
}

// realpathSync normalises a Windows short (8.3) path such as C:\Users\ASAFG~1\... to its
// long form. It does not differ on every machine — it did not on the one this plan was
// written on — but a mismatch between the path we write to and the path tooling resolves
// shows up as confusing module-resolution failures, and one call removes the class.
const outDir = realpathSync(mkdtempSync(join(tmpdir(), "cnc-standalone-")));
const checks: { name: string; ok: boolean; output: string }[] = [];

try {
  await initFormatter();
  if (!formatterAvailable()) throw new Error("@biomejs/biome is required for this check.");

  const spec = parseSpec(
    JSON.parse(await Bun.file(join(scriptDir, "..", "fixtures", `${NAME}.spec.json`)).text()),
  );
  await writeFiles(formatAll(generate(spec, { target: "standalone" })), outDir);

  // Point the generated dependency at the local checkout until 1.11.0 is on the registry.
  const pkgPath = join(outDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies["@nimbus-dev/sdk"] = `file:${sdkPkg.replaceAll("\\", "/")}`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, undefined, 2)}\n`);

  // --force so a rebuilt SDK at the same path and version is not served from bun's cache.
  // The temp dir is fresh so node_modules is empty, but the cached *file:* package is not.
  checks.push({ name: "bun install", ...run(["bun", "install", "--force"], outDir) });

  // Do not trust --force to have worked — prove the built kit actually landed. A stale or
  // partial install would otherwise surface as a confusing tsc error about missing types.
  const installedKit = join(
    outDir,
    "node_modules",
    "@nimbus-dev",
    "sdk",
    "dist",
    "connector-kit",
    "index.js",
  );
  checks.push({
    name: "connector-kit present in node_modules",
    ok: existsSync(installedKit),
    output: existsSync(installedKit)
      ? installedKit
      : `${installedKit} is missing — the SDK installed without the connector-kit build output`,
  });

  checks.push({ name: "tsc --noEmit", ...run(["bunx", "tsc", "--noEmit"], outDir) });

  const escaping = run(["grep", "-rn", "\\.\\./\\.\\.", "src"], outDir);
  checks.push({
    name: "no relative import escapes the package",
    ok: escaping.output.trim() === "",
    output: escaping.output,
  });

  const expectedTools = spec.tools.map((t) => t.name);

  // src/server.ts is what `bun run dev` runs — worth proving on its own, independent of
  // the bundler.
  checks.push({
    name: "tools/list over stdio (src)",
    ...(await toolsListCheck(outDir, "src/server.ts", expectedTools)),
  });

  // nimbus.extension.json declares entrypoint: "dist/server.js", which is what the Nimbus
  // Gateway actually launches. Nothing else in this project builds or runs that artifact,
  // so prove `bun run build` produces it before trusting the source-level checks above.
  checks.push({ name: "bun run build", ...run(["bun", "run", "build"], outDir) });
  const builtServer = join(outDir, "dist", "server.js");
  checks.push({
    name: "dist/server.js exists after build",
    ok: existsSync(builtServer),
    output: existsSync(builtServer)
      ? builtServer
      : `${builtServer} is missing — \`bun run build\` did not produce the entrypoint the Gateway launches`,
  });

  // The build check above only proves the artifact exists, not that it runs. A bundler
  // can externalize or strip an import in a way that leaves every source-level check
  // green while dist/server.js is broken — so drive the actual Gateway-launched file
  // over stdio too, not just the unbundled source.
  checks.push({
    name: "tools/list over stdio (dist/server.js)",
    ...(await toolsListCheck(outDir, "dist/server.js", expectedTools)),
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.ok && c.output !== "") console.log(c.output);
}

if (checks.some((c) => !c.ok)) process.exit(1);
console.log("\nAll standalone acceptance checks passed.");

async function toolsListCheck(
  cwd: string,
  entryPath: string,
  expected: readonly string[],
): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bun", entryPath], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // No credential env vars are set. Accessors are only called inside tool handlers,
    // so a clean tools/list proves the server starts and describes itself without secrets.
  });

  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "standalone-acceptance", version: "0.0.0" },
      },
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let sawInitialized = false;

    // Read until the tools/list response (id 2) arrives, the process exits, or the timeout kills it.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      const lines = buffered.split("\n");
      buffered = lines.pop() ?? ""; // keep the trailing partial fragment

      for (const line of lines) {
        if (line.trim() === "") continue;
        let msg: { id?: unknown; result?: { tools?: Array<{ name?: string }> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a warning or other non-JSON output — not a protocol error
        }

        if (msg.id === 1 && !sawInitialized) {
          sawInitialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
          continue;
        }

        if (msg.id === 2) {
          const names = (msg.result?.tools ?? []).map((t) => t.name);
          const missing = expected.filter((n) => !names.includes(n));
          return {
            ok: missing.length === 0,
            output:
              missing.length === 0
                ? `tools/list returned ${names.join(", ")}`
                : `tools/list missing ${missing.join(", ")}; got ${names.join(", ") || "(none)"}`,
          };
        }
      }
    }

    const stderr = await new Response(proc.stderr).text();
    return { ok: false, output: `server exited before answering tools/list.\n${stderr.trim()}` };
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}
