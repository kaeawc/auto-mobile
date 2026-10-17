import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimctlRuntimes } from "../../../src/utils/ios-cmdline-tools/simctlRuntimes";

const captured = readFileSync(
  join(import.meta.dir, "../../fixtures/ios-simctl/list-runtimes.json"),
  "utf8",
);

describe("parseSimctlRuntimes", () => {
  test("captured list runtimes output parses under every filter", () => {
    const listed = parseSimctlRuntimes(captured);
    expect(listed.length).toBe(8);
    expect(parseSimctlRuntimes(captured, "not-unavailable")).toHaveLength(listed.length);
    expect(parseSimctlRuntimes(captured, "available")).toHaveLength(listed.length);
  });

  test("filters differ on missing and false availability", () => {
    const stdout = JSON.stringify({
      runtimes: [
        { name: "a", isAvailable: true },
        { name: "b", isAvailable: false },
        { name: "c" },
      ],
    });
    const names = (filter: "listed" | "not-unavailable" | "available") =>
      parseSimctlRuntimes(stdout, filter).map((runtime) => runtime.name);
    expect(names("listed")).toEqual(["a", "b", "c"]);
    expect(names("not-unavailable")).toEqual(["a", "c"]);
    expect(names("available")).toEqual(["a"]);
  });

  test("rejects malformed output", () => {
    expect(() => parseSimctlRuntimes("not json")).toThrow();
    expect(() => parseSimctlRuntimes("{}")).toThrow("does not contain a runtimes array");
  });
});
