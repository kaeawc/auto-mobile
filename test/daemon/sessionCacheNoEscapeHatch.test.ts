import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard against re-introducing the untyped `customData` escape hatch (issue #2973,
 * follow-up to #2917).
 *
 * PR #2929 promoted the observe cache to typed slots but left
 * `customData?: Record<string, any>` — which still held well-known, fixed-type
 * keyed state (keep-awake, device-label map) fished out with unchecked `as` casts.
 * A writer/reader type drift on any such key is invisible at compile time: the
 * exact #2917 decoy bug.
 *
 * This is a source-scan meta-test (repo convention, cf. #3081/#3085): it fails
 * HERE, in a <100ms unit test, if someone reintroduces the bag or an unchecked
 * cast out of it — instead of shipping a latent type-drift bug.
 */
describe("SessionCacheData has no untyped escape hatch (issue #2973)", () => {
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

  const SESSION_MANAGER = "src/daemon/sessionManager.ts";
  // Files that previously read/wrote well-known keys through `customData`.
  const FORMER_CUSTOMDATA_CONSUMERS = [
    SESSION_MANAGER,
    "src/server/ToolExecutionContext.ts",
    "src/server/deviceLabelMapping.ts",
    "src/daemon/socketServer.ts",
  ];

  // Extract the `SessionCacheData` declaration body from the source. Matches both
  // `interface SessionCacheData { … }` and a `type SessionCacheData = { … }` alias
  // (so a future refactor doesn't silently disable the guard), and anchors the
  // close on a column-0 `}` (`^\}` multiline) rather than any `\n}` — nested
  // object slots keep their `}` indented, so the non-greedy body still ends at the
  // real declaration close.
  function sessionCacheDataBody(): string {
    const source = read(SESSION_MANAGER);
    const match = source.match(/(?:interface|type)\s+SessionCacheData\b[^{]*\{([\s\S]*?)^\}/m);
    expect(match).not.toBeNull();
    return match![1];
  }

  test("EC1: SessionCacheData exposes typed keepScreenAwake + deviceLabels slots", () => {
    const body = sessionCacheDataBody();
    expect(body).toMatch(/keepScreenAwake\?\s*:\s*KeepScreenAwakeState/);
    expect(body).toMatch(/deviceLabels\?\s*:\s*DeviceLabelMap/);
  });

  test("EC2: SessionCacheData has no customData / Record<string, any> escape hatch", () => {
    const body = sessionCacheDataBody();
    expect(body).not.toContain("customData");
    expect(body).not.toMatch(/Record<\s*string\s*,\s*any\s*>/);
  });

  test("EC7: no consumer reads a well-known key out of customData via an unchecked cast", () => {
    for (const rel of FORMER_CUSTOMDATA_CONSUMERS) {
      const source = read(rel);
      // The `.customData` member access is gone entirely — the bag no longer exists.
      expect(source, `${rel} must not access .customData`).not.toMatch(/\.customData\b/);
      // And the specific unchecked casts the issue called out are gone.
      expect(source, `${rel} must not cast to KeepScreenAwakeState out of the bag`)
        .not.toMatch(/as\s+KeepScreenAwakeState\s*\|\s*undefined/);
    }
  });
});
