import { describe, expect, test } from "bun:test";
import { validatePrototypePushPayload } from "../../../src/features/prototype/prototypePush";
import {
  buildIosPushPayload,
  SIMCTL_PUSH_PAYLOAD_LIMIT_BYTES,
} from "../../../src/features/utility/iosPushPayload";

/** A payload whose compact JSON is exactly `bytes` long. */
function payloadOfBytes(bytes: number): { type: string; data: { text: string } } {
  const empty = JSON.stringify({ type: "message", data: { text: "" } });
  return { type: "message", data: { text: "x".repeat(bytes - empty.length) } };
}

describe("validatePrototypePushPayload", () => {
  test("accepts a typed push with data and a notification, and returns its compact JSON", () => {
    const payload = {
      type: "message",
      data: { id: "m1", sender: "Ada", text: "Hi", unread: 2, tags: ["a"], read: null },
      notification: { title: "Ada", body: "Hi", channel: "chat", group: "ada", badge: 3 },
    };
    const result = validatePrototypePushPayload(payload);
    expect(result).toEqual({ success: true, payload, json: JSON.stringify(payload) });
  });

  test("defaults data to an empty object", () => {
    expect(validatePrototypePushPayload({ type: "ping" })).toMatchObject({
      success: true,
      payload: { type: "ping", data: {} },
    });
  });

  test("accepts exactly 4096 bytes of compact JSON and refuses 4097", () => {
    expect(JSON.stringify(payloadOfBytes(4096)).length).toBe(SIMCTL_PUSH_PAYLOAD_LIMIT_BYTES);
    expect(validatePrototypePushPayload(payloadOfBytes(4096)).success).toBe(true);
    const over = validatePrototypePushPayload(payloadOfBytes(4097));
    expect(over.success).toBe(false);
    expect(!over.success && over.error).toMatchObject({ code: "invalid_args", path: "data" });
    expect(!over.success && over.error.message).toContain("4097 bytes");
  });

  test("counts UTF-8 bytes, not characters, against the limit", () => {
    const empty = JSON.stringify({ type: "message", data: { text: "" } }).length;
    // Each "é" is two UTF-8 bytes, so this is over 4096 bytes in fewer than 4096 characters.
    const text = "é".repeat(Math.ceil((4097 - empty) / 2));
    expect(empty + text.length).toBeLessThan(4096);
    expect(validatePrototypePushPayload({ type: "message", data: { text } }).success).toBe(false);
  });

  test("shares the 4 KiB limit with the simctl push payload builder", () => {
    const built = buildIosPushPayload(
      { title: "t", body: "x".repeat(SIMCTL_PUSH_PAYLOAD_LIMIT_BYTES) },
      "com.example",
    );
    expect(built.ok).toBe(false);
  });

  test.each([
    [{}, "data.type"],
    [{ type: "" }, "data.type"],
    [{ type: "has-dash" }, "data.type"],
    [{ type: "a".repeat(65) }, "data.type"],
    [{ type: "m", data: [] }, "data.data"],
    [{ type: "m", data: { n: Number.NaN } }, "data.data.n"],
    [{ type: "m", extra: 1 }, "data"],
    [{ type: "m", notification: { body: "b" } }, "data.notification.title"],
    [{ type: "m", notification: { title: "  " } }, "data.notification.title"],
    [{ type: "m", notification: { title: "t".repeat(129) } }, "data.notification.title"],
    [{ type: "m", notification: { title: "t", body: "b".repeat(1025) } }, "data.notification.body"],
    [{ type: "m", notification: { title: "t", channel: "a b" } }, "data.notification.channel"],
    [
      { type: "m", notification: { title: "t", group: "g".repeat(129) } },
      "data.notification.group",
    ],
    [{ type: "m", notification: { title: "t", badge: 10000 } }, "data.notification.badge"],
    [{ type: "m", notification: { title: "t", badge: 1.5 } }, "data.notification.badge"],
    [{ type: "m", notification: { title: "t", sound: "x" } }, "data.notification"],
  ])("refuses %j at %s", (payload, path) => {
    const result = validatePrototypePushPayload(payload);
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toMatchObject({ code: "invalid_args", path });
  });

  test("accepts the boundary values of every notification field", () => {
    const result = validatePrototypePushPayload({
      type: "a".repeat(64),
      notification: {
        title: "t".repeat(128),
        body: "b".repeat(1024),
        channel: "c".repeat(64),
        group: "g".repeat(128),
        badge: 9999,
      },
    });
    expect(result.success).toBe(true);
    expect(
      validatePrototypePushPayload({ type: "_", notification: { title: "t", badge: 0 } }).success,
    ).toBe(true);
  });
});
