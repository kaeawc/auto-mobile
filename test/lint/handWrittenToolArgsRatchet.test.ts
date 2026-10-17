import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Hand-written `interface *Args` types in `src/server` drift from the zod wire schema (#6154).
 * `defineDeviceTool` / `definePlainTool` (src/server/defineTool.ts) infer handler args from the
 * schema instead (#11824). Migrating a tool removes its interface; this cap may only shrink, so a
 * new tool defines its args through the helper rather than adding another interface.
 */
const MAX_HAND_WRITTEN_ARGS_INTERFACES = 54;

const SERVER_DIR = join(import.meta.dir, "..", "..", "src", "server");
const ARGS_INTERFACE = /^(export )?interface [A-Za-z]+Args\b/gm;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("hand-written *Args interfaces in src/server only shrink", () => {
  const count = sourceFiles(SERVER_DIR).reduce(
    (total, file) => total + (readFileSync(file, "utf8").match(ARGS_INTERFACE)?.length ?? 0),
    0,
  );
  expect(
    count,
    `src/server has ${count} hand-written *Args interfaces (cap ${MAX_HAND_WRITTEN_ARGS_INTERFACES}). Define the tool with defineDeviceTool/definePlainTool so args are inferred from the schema; if you removed some, lower the cap.`,
  ).toBeLessThanOrEqual(MAX_HAND_WRITTEN_ARGS_INTERFACES);
});
