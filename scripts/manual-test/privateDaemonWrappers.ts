import { isAbsolute, join, relative, sep } from "node:path";
import { shellQuote } from "../../src/utils/shellQuote";
import type { HostDefaults, PrivateDaemonSpec } from "./privateDaemonEnv";

/** Absolute, quoted paths make these wrappers independent of the caller's cwd. */
export function renderPrivateDaemonWrappers(
  batchDir: string,
  index: number,
  repoRoot: string,
): Record<string, string> {
  const script = shellQuote(join(repoRoot, "scripts/manual-test/in-daemon-env.sh"));
  const prefix = `#!/usr/bin/env bash\nset -euo pipefail\nexec bash ${script} --batch-dir ${shellQuote(batchDir)} --daemon ${index}`;
  return {
    [`am${index}`]: `${prefix} --cd ${shellQuote(repoRoot)} "$@"\n`,
    ...Object.fromEntries(
      ["proxy", "frame", "aux"].map((name) => [`${name}${index}`, `${prefix} ${name} "$@"\n`]),
    ),
    [`broker${index}`]: `#!/usr/bin/env bash\nset -euo pipefail\nexec bash ${script} --batch-dir ${shellQuote(batchDir)} --daemon 1 -- bun ${shellQuote(join(repoRoot, "scripts/manual-test/broker-batch.ts"))} "$@"\n`,
  };
}
export function writePrivateDaemonWrappers(
  batchDir: string,
  specs: PrivateDaemonSpec[],
  deps: {
    repoRoot: string;
    host: HostDefaults;
    mkdir(path: string, mode: number): void;
    writeFile(path: string, text: string): void;
    chmod(path: string, mode: number): void;
  },
): void {
  const bin = join(batchDir, "bin");
  const files = specs.flatMap((spec) =>
    Object.entries(renderPrivateDaemonWrappers(batchDir, spec.index, deps.repoRoot)).map(
      ([name, text]) => ({ path: join(bin, name), text }),
    ),
  );
  const canonicalBin = deps.host.canonicalize(bin);
  requireInside(canonicalBin, deps.host.canonicalize(batchDir));
  for (const file of files) {
    requireInside(deps.host.canonicalize(file.path), canonicalBin);
  }
  deps.mkdir(bin, 0o700);
  for (const { path, text } of files) {
    deps.writeFile(path, text);
    deps.chmod(path, 0o755);
  }
}
function requireInside(path: string, root: string): void {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Refusing wrapper path outside <batch>/bin.");
  }
}
