/** Runs a command synchronously, capturing combined stdout+stderr. Shared by the acceptance scripts. */
export function run(cmd: string[], cwd: string): { ok: boolean; output: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: r.exitCode === 0,
    output: `${r.stdout.toString()}${r.stderr.toString()}`.trim(),
  };
}
