import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  IDE_DEVICE_MUTATION_METHODS,
  IDE_ROUTE_ADMISSION,
  STARTUP_PROBE_METHODS,
} from "../../src/daemon/ideRoutes";

/** #11813: the `ide/*` admission classes live in one table, with the sets they replaced unchanged. */
describe("ide/* admission table", () => {
  test("the derived sets equal the method-name sets the server used to hold", () => {
    expect([...STARTUP_PROBE_METHODS].sort()).toEqual(["ide/ping", "ide/status"]);
    expect([...IDE_DEVICE_MUTATION_METHODS].sort()).toEqual([
      "ide/clearKeyValueFile",
      "ide/removeKeyValue",
      "ide/setKeyValue",
      "ide/updateService",
    ]);
  });

  test("every classified method has a handler entry in the server", () => {
    const source = readFileSync("src/daemon/socketServer.ts", "utf8");
    for (const method of Object.keys(IDE_ROUTE_ADMISSION)) {
      expect(source).toMatch(new RegExp(`\\[\\s*"${method}",`));
    }
  });

  test("a method has exactly one class", () => {
    for (const method of Object.keys(IDE_ROUTE_ADMISSION)) {
      expect(
        Number(STARTUP_PROBE_METHODS.has(method)) + Number(IDE_DEVICE_MUTATION_METHODS.has(method)),
      ).toBe(1);
    }
  });

  test("the server keeps no ide/ method-name admission sets", () => {
    const source = readFileSync("src/daemon/socketServer.ts", "utf8");
    expect(source).not.toMatch(/new Set\(\[\s*"ide\//);
  });
});
