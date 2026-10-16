import { expect, test } from "bun:test";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { createTestUnixSocketServer, fakeBindLock } from "./createTestUnixSocketServer";

test("fake bind lock is immediately available and reusable", () => {
  expect(fakeBindLock.acquire()).toBe(true);
  expect(fakeBindLock.release()).toBeUndefined();
  expect(fakeBindLock.acquire()).toBe(true);
});

test("constructs with defaults and an explicit bind lock", () => {
  expect(createTestUnixSocketServer(undefined, "http://localhost/mcp")).toBeInstanceOf(
    UnixSocketServer,
  );
  expect(
    createTestUnixSocketServer(
      undefined,
      "http://localhost/mcp",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { bindLock: fakeBindLock },
      undefined,
    ),
  ).toBeInstanceOf(UnixSocketServer);
});
