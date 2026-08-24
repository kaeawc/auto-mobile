import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Structural tripwire for `bunfig.toml`'s `[test].preload` (issues #3084/#4186).
 *
 * The preload installs process-wide telemetry neutralization before any test
 * imports a production singleton; deleting it silently re-opens the real
 * `~/.auto-mobile` DB, and because the recorder swallows the guard throw NO test
 * fails — the protection can vanish unnoticed. This asserts the entry is present
 * by PARSING the TOML (via Bun's native parser — no new dependency; smol-toml is
 * only a transitive dep of knip), not a substring grep.
 *
 * The file is resolved relative to THIS test (`import.meta.url`), not the working
 * directory, so the tripwire holds regardless of the cwd the runner is invoked
 * from.
 */
describe("bunfig.toml test preload tripwire (#3084)", () => {
  const parsed = Bun.TOML.parse(
    readFileSync(new URL("../../bunfig.toml", import.meta.url), "utf8"),
  ) as { test?: { preload?: string[] } };

  test("[test].preload is a non-empty array", () => {
    expect(Array.isArray(parsed.test?.preload)).toBe(true);
    expect(parsed.test?.preload?.length ?? 0).toBeGreaterThan(0);
  });

  test("[test].preload registers testPreload.ts", () => {
    expect(parsed.test?.preload).toContain("./test/setup/testPreload.ts");
  });
});
