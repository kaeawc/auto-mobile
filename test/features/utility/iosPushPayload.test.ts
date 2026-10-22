import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildIosPushPayload,
  IOS_PUSH_IMAGE_URL_KEY,
  SIMCTL_PUSH_PAYLOAD_LIMIT_BYTES,
  type IosPushPayloadOptions,
} from "../../../src/features/utility/iosPushPayload";

const BUNDLE = "com.example.App";

function build(options: Partial<IosPushPayloadOptions>) {
  return buildIosPushPayload({ title: "Hello", body: "World", ...options }, BUNDLE);
}

function parsed(options: Partial<IosPushPayloadOptions>): Record<string, any> {
  const result = build(options);
  if (!result.ok) {
    throw new Error(`expected a payload, got: ${result.error}`);
  }
  return JSON.parse(result.json);
}

describe("buildIosPushPayload", () => {
  test("generates alert, sound and the simulator target bundle", () => {
    expect(parsed({})).toEqual({
      aps: { alert: { title: "Hello", body: "World" }, sound: "default" },
      "Simulator Target Bundle": BUNDLE,
    });
  });

  test("category sets aps.category and wins over the legacy channelId", () => {
    expect(parsed({ category: "reply" }).aps.category).toBe("reply");
    expect(parsed({ channelId: "legacy" }).aps.category).toBe("legacy");
    expect(parsed({ category: "reply", channelId: "legacy" }).aps.category).toBe("reply");
  });

  test("actions with a category are dropped with a warning that names the category source", () => {
    const result = build({ category: "reply", actions: [{ label: "Open", actionId: "open" }] });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("UNNotificationCategory the app registered");
    expect(result.warnings.join(" ")).not.toContain("require category");
  });

  test("actions without a category warn that a category is required", () => {
    const result = build({ actions: [{ label: "Open", actionId: "open" }] });
    expect(result.warnings.join(" ")).toContain("require category");
  });

  test("an image sets mutable-content and the documented image URL key", () => {
    const payload = parsed({ imageType: "bigPicture", imagePath: "https://example.com/a.png" });
    expect(payload.aps["mutable-content"]).toBe(1);
    expect(payload[IOS_PUSH_IMAGE_URL_KEY]).toBe("https://example.com/a.png");
    expect(build({ imagePath: "https://example.com/a.png" }).warnings.join(" ")).toContain(
      "Notification Service Extension",
    );
  });

  test("an absolute host image path becomes a file URL", () => {
    // The payload resolves the path on the host, so a Windows host adds a drive letter.
    const imagePath = "/tmp/images/a b.png";
    expect(parsed({ imagePath })[IOS_PUSH_IMAGE_URL_KEY]).toBe(
      pathToFileURL(resolve(imagePath)).href,
    );
  });

  test("bigPicture without imagePath sends no image and says so", () => {
    const result = build({ imageType: "bigPicture" });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(JSON.parse(result.json).aps["mutable-content"]).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("bigPicture needs imagePath");
  });

  test("a raw payload round-trips custom keys and overrides generated aps fields", () => {
    const payload = parsed({
      category: "reply",
      payload: {
        orderId: "A-1",
        nested: { deep: [1, 2, 3] },
        aps: { "interruption-level": "time-sensitive", "thread-id": "t1", sound: "chime.caf" },
      },
    });
    expect(payload.orderId).toBe("A-1");
    expect(payload.nested).toEqual({ deep: [1, 2, 3] });
    expect(payload.aps).toEqual({
      alert: { title: "Hello", body: "World" },
      sound: "chime.caf",
      category: "reply",
      "interruption-level": "time-sensitive",
      "thread-id": "t1",
    });
  });

  test("the target bundle always names the bundle the push is sent to", () => {
    expect(parsed({ payload: { "Simulator Target Bundle": "com.other" } })).toMatchObject({
      "Simulator Target Bundle": BUNDLE,
    });
  });

  test("a non-object aps in the raw payload is refused", () => {
    const result = build({ payload: { aps: "nope" } });
    expect(result).toMatchObject({
      ok: false,
      error: "payload.aps must be a JSON object when provided.",
    });
  });

  test("the size cap covers the merged payload, including raw keys", () => {
    const filler = (size: number) => ({ blob: "x".repeat(size) });
    const base = Buffer.byteLength(
      JSON.stringify({ blob: "", ...JSON.parse((build({}) as { json: string }).json) }),
      "utf8",
    );
    const atLimit = build({ payload: filler(SIMCTL_PUSH_PAYLOAD_LIMIT_BYTES - base) });
    expect(atLimit.ok).toBe(true);
    const overLimit = build({ payload: filler(SIMCTL_PUSH_PAYLOAD_LIMIT_BYTES - base + 1) });
    expect(overLimit).toMatchObject({ ok: false });
    expect(overLimit.ok ? "" : overLimit.error).toContain("4096");
  });
});
