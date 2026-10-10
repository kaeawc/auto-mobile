/**
 * AutoMobile's published entrypoint is a Bun bundle (`engines.bun`, `#!/usr/bin/env bun`). Running
 * it with `node dist/src/index.js` otherwise dies deep inside the bundle with an opaque
 * "u1 is not a function" stack trace, even for `--help`/`--version`. This module must be imported
 * before any other module in the entrypoint so the unsupported runtime is reported up front.
 */

export interface RuntimeGuardIo {
  readonly versions: { readonly bun?: string; readonly node?: string };
  writeStderr(text: string): void;
  exit(code: number): void;
}

export function unsupportedRuntimeMessage(versions: RuntimeGuardIo["versions"]): string | null {
  if (versions.bun) {
    return null;
  }
  const runtime = versions.node ? `Node.js ${versions.node}` : "this JavaScript runtime";
  return (
    `auto-mobile requires the Bun runtime (>= 1.3.14), but it was started with ${runtime}.\n` +
    "Run it with Bun instead:\n" +
    "  bun dist/src/index.js <args>\n" +
    "  bunx @kaeawc/auto-mobile@latest <args>\n" +
    "Install Bun from https://bun.sh.\n"
  );
}

export function enforceBunRuntime(io: RuntimeGuardIo): boolean {
  const message = unsupportedRuntimeMessage(io.versions);
  if (message === null) {
    return true;
  }
  io.writeStderr(message);
  io.exit(1);
  return false;
}

enforceBunRuntime({
  versions: process.versions as RuntimeGuardIo["versions"],
  writeStderr: (text) => {
    process.stderr.write(text);
  },
  exit: (code) => process.exit(code),
});
