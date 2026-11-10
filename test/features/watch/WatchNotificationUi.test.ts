import { afterEach, expect, test } from "bun:test";
import { watchTapOn } from "../../../src/features/watch/WatchActions";
import { normalizeWatchHierarchy } from "../../../src/features/watch/WatchHierarchy";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
import permissionAlert from "../../fixtures/watchos-xcuitest/notification-permission-alert.json";
import shortLook from "../../fixtures/watchos-xcuitest/notification-short-look.json";
import longLook from "../../fixtures/watchos-xcuitest/notification-long-look.json";

function elements(value: unknown) {
  return new DefaultElementParser()
    .flattenViewHierarchy(normalizeWatchHierarchy(value))
    .map((entry) => entry.element);
}

const deviceId = "watch-notification-ui";
let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

test("normalizes the captured notification short look from the runner response data", () => {
  const texts = elements(shortLook.data).map((element) => element.text);
  expect(texts).toContain("Invite");
  expect(texts).toContain("Join the meeting?");
});

test("normalizes the captured notification long look including its actions", () => {
  const texts = elements(longLook.data).map((element) => element.text);
  expect(texts).toContain("Accept");
  expect(texts).toContain("Decline");
  expect(texts).toContain("Dismiss");
});

test.each([
  { index: 0, className: "XCUIElementType(75)" },
  { index: 1, className: "XCUIElementType(48)" },
])(
  "taps the captured Accept $className at its center without an identifier",
  async ({ index, className }) => {
    const client = new FakeWatchRunnerClient(longLook.data);
    unregister = watchRunners.register(deviceId, client);
    const accept = elements(longLook.data).filter((element) => element.text === "Accept")[index];
    expect(accept).toMatchObject({ class: className });
    expect(accept?.["resource-id"]).toBeUndefined();

    const result = await watchTapOn(deviceId, { action: "tap", text: "Accept", index });

    expect(result).toEqual({ success: true, action: "tap", element: accept });
    // Both captured Accept nodes have the same center in XCTest points.
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "hierarchy" },
      { type: "tap", x: 93.5, y: 131 },
    ]);
  },
);

test.each([
  { text: "Allow", bounds: { left: 73, top: 260, right: 113, bottom: 283 } },
  { text: "Don’t Allow", bounds: { left: 51, top: 212, right: 135, bottom: 235 } },
])(
  "does not tap the captured permission choice $text until wholly on screen",
  async ({ text, bounds }) => {
    const client = new FakeWatchRunnerClient(permissionAlert.data);
    unregister = watchRunners.register(deviceId, client);
    const button = elements(permissionAlert.data).find(
      (element) => element.text === text && element.class === "XCUIElementType(9)",
    );
    expect(button).toMatchObject({ bounds });
    expect(permissionAlert.data.screenHeight).toBe(223);
    expect(bounds.bottom).toBeGreaterThan(permissionAlert.data.screenHeight);

    await expect(watchTapOn(deviceId, { action: "tap", text })).rejects.toThrow(
      "No watch element matched",
    );
    expect(client.commands).toEqual([{ type: "face", op: "dump" }, { type: "hierarchy" }]);
  },
);
