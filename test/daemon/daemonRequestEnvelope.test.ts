import { describe, expect, test } from "bun:test";
import {
  daemonRequestEnvelopeSchema,
  isDaemonRequestEnvelope,
  readFramePlatformHint,
} from "../../src/daemon/daemonRequestEnvelope";

describe("daemon request envelope", () => {
  test.each(["mcp_request", "daemon_request"])("accepts a %s frame", (type) => {
    expect(isDaemonRequestEnvelope({ id: "1", type, method: "tools/call" })).toBe(true);
  });

  test("keeps params and unknown additive fields", () => {
    const parsed = daemonRequestEnvelopeSchema.parse({
      id: "1",
      type: "daemon_request",
      method: "input/tap",
      params: { x: 1 },
      timeoutMs: 5,
    });
    expect(parsed.params).toEqual({ x: 1 });
    expect(parsed.timeoutMs).toBe(5);
  });

  test("rejects malformed envelopes", () => {
    const frames: unknown[] = [
      null,
      [],
      "x",
      {},
      { id: 1, type: "mcp_request", method: "m" },
      { id: "1", type: "other", method: "m" },
      { id: "1", type: "mcp_request" },
    ];
    for (const frame of frames) {
      expect(isDaemonRequestEnvelope(frame)).toBe(false);
    }
  });
});

describe("readFramePlatformHint", () => {
  test("reads android and ios", () => {
    expect(readFramePlatformHint({ platform: "ios", x: 1 })).toBe("ios");
    expect(readFramePlatformHint({ platform: "android" })).toBe("android");
  });

  test("returns undefined for absent or malformed params", () => {
    const cases: unknown[] = [undefined, null, [], "ios", {}, { platform: "web" }, { platform: 1 }];
    for (const params of cases) {
      expect(readFramePlatformHint(params)).toBeUndefined();
    }
  });
});
