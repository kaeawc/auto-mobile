import { describe, expect, test } from "bun:test";
import { DaemonUnavailableError, toDaemonTransportError } from "../../src/daemon/client";
import { DaemonDisconnectError } from "../../src/daemon/DaemonDisconnectError";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";

test("daemon disconnect context is distinct from a deadline breach", () => {
  const error = new DaemonDisconnectError({ toolName: "tools/list", origin: "test" });
  expect(error.name).toBe("DaemonDisconnectError");
  expect(error.toolName).toBe("tools/list");
  expect(error.origin).toBe("test");
  expect(error).not.toBeInstanceOf(McpTimeoutError);
});

describe("toDaemonTransportError", () => {
  test("wraps a raw transport error as a recoverable DaemonUnavailableError", () => {
    const raw = new Error("read ECONNRESET");
    (raw as NodeJS.ErrnoException).code = "ECONNRESET";

    const wrapped = toDaemonTransportError(raw);

    expect(wrapped).toBeInstanceOf(DaemonUnavailableError);
    expect(wrapped.message).toContain("ECONNRESET");
  });

  test("wraps EPIPE and socket hang up the same way", () => {
    for (const message of ["write EPIPE", "socket hang up"]) {
      const wrapped = toDaemonTransportError(new Error(message));
      expect(wrapped).toBeInstanceOf(DaemonUnavailableError);
      expect(wrapped.message).toContain(message);
    }
  });

  test("passes an already-typed error through unchanged", () => {
    const original = new DaemonUnavailableError("Socket connection lost");
    expect(toDaemonTransportError(original)).toBe(original);
  });
});
