#!/usr/bin/env bun
// Runtime guard stays first so a non-Bun runtime gets a clear message instead of a bundle stack
// trace; processEntry must follow it immediately: captures the launcher pid before anything else runs (#11041).
import "./runtime/bunRuntimeGuard";
import "./daemon/processEntry";
import "./runtime/reflectMetadata";
import { hasGlobalVersionFlag } from "./cli/versionFlag";

// Nothing else is imported statically: `--version` must not load (or evaluate) the server graph
// (#17684), so both paths are dynamic imports. The server path keeps its wiring order inside
// ./startup/serverEntry. No top-level await, so the entry also builds as cjs or a compiled binary.

/** Last-resort report for a failure while loading an entry module, before any logger exists. */
function failEntryLoad(error: unknown): never {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal error loading AutoMobile: ${message}\n`);
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
if (hasGlobalVersionFlag(rawArgs)) {
  import("./startup/versionEntrypoint")
    .then(({ runVersionEntrypoint }) => runVersionEntrypoint(rawArgs))
    .catch(failEntryLoad);
} else {
  // Bun sets import.meta.main on the entrypoint module; under `module: ESNext`
  // this type-checks without a suppression.
  const isMain = import.meta.main;
  import("./startup/serverEntry")
    .then(({ runServerEntry }) => {
      if (isMain) {
        runServerEntry();
      }
    })
    .catch(failEntryLoad);
}
