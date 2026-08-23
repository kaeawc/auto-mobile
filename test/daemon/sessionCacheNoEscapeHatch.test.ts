import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
      expect(source, `${rel} must not cast to KeepScreenAwakeState out of the bag`).not.toMatch(
        /as\s+KeepScreenAwakeState\s*\|\s*undefined/,
      );
    }
  });

  // -- Setter-bypass guard (issue #3219, follow-up to #2973) -----------------
  //
  // Now that the well-known slots are typed, the only remaining hole #2973 called
  // out as "optional/interim" is that `updateSessionCache` is public, so a caller
  // *could* write `keepScreenAwake` / `deviceLabels` directly rather than going
  // through `setKeepScreenAwake` / `setDeviceLabels`. Every such write is already
  // TS-type-checked (so the #2917 type-drift class can't slip through), but the
  // convention is "force through the setter". This source scan enforces it in
  // production code only — tests may still write the slots directly through the
  // public, compile-checked `updateSessionCache`.

  // Slots that have dedicated setters and must be written only via them in `src/`.
  const SETTER_ONLY_SLOTS = ["keepScreenAwake", "deviceLabels"] as const;

  // Recursively list every `.ts` file under `src/`, skipping declaration files.
  function listSrcTsFiles(): string[] {
    const root = join(process.cwd(), "src");
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
          out.push(abs);
        }
      }
    };
    walk(root);
    return out;
  }

  test("EC8: production code writes setter-only slots only via SessionManager setters", () => {
    const sessionManagerAbs = join(process.cwd(), SESSION_MANAGER);
    // `sessionManager.ts` is where the setters and `updateSessionCache` live, so
    // it is (by design) the one place that writes the slots directly.
    const files = listSrcTsFiles().filter((abs) => abs !== sessionManagerAbs);

    // A single `updateSessionCache( … )` call, argument list captured (non-greedy,
    // no nested braces) so we can look for a typed-slot key inside it. Anchoring on
    // the call site avoids false positives from Zod schemas / request DTOs that
    // happen to have a `keepScreenAwake:` field of their own.
    const UPDATE_CALL = /updateSessionCache\s*\(([^)]*\{[^{}]*\}[^)]*)\)/g;

    for (const abs of files) {
      const source = readFileSync(abs, "utf8");
      const rel = abs.slice(process.cwd().length + 1);
      for (const slot of SETTER_ONLY_SLOTS) {
        const setter = `set${slot[0].toUpperCase()}${slot.slice(1)}`;

        // 1. No direct member-assignment to the slot, e.g. `session.cacheData.deviceLabels = …`
        //    (the `[^=]` lookahead lets `===`/`==` comparisons through).
        expect(
          source,
          `${rel} must not assign .${slot} directly — use SessionManager.${setter}()`,
        ).not.toMatch(new RegExp(`\\.${slot}\\s*=[^=]`));

        // 2. No `updateSessionCache(id, { keepScreenAwake | deviceLabels })` bypass —
        //    scan only inside the call's argument list so unrelated object literals
        //    (schemas, request objects) don't trip the guard.
        for (const call of source.matchAll(UPDATE_CALL)) {
          expect(
            call[1].match(new RegExp(`\\b${slot}\\s*[:,}]`)),
            `${rel} must not pass { ${slot} } to updateSessionCache — use SessionManager.${setter}()`,
          ).toBeNull();
        }
      }
    }
  });
});
