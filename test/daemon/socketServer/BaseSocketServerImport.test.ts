import { BaseSocketServer } from "../../../src/daemon/socketServer/BaseSocketServer";
import { expect, test } from "bun:test";

// Run this file alone too, so a previously loaded barrel cannot hide an import cycle.
test("BaseSocketServer loads first without constructing a server", () => {
  expect(typeof BaseSocketServer).toBe("function");
});
