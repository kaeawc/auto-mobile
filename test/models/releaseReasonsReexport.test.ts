import { describe, expect, test } from "bun:test";
import * as daemonPath from "../../src/daemon/releaseReasons";
import * as modelsPath from "../../src/models/releaseReasons";

// #11789: releaseReasons moved down into `models` so `db` can import it; the daemon path must stay identical.
describe("releaseReasons tier move", () => {
  test("daemon path re-exports every models export by identity", () => {
    const names = Object.keys(modelsPath);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect((daemonPath as Record<string, unknown>)[name]).toBe(
        (modelsPath as Record<string, unknown>)[name],
      );
    }
  });
});
