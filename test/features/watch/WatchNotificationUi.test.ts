import { afterEach, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import { watchTapOn } from "../../../src/features/watch/WatchActions";
import { normalizeWatchHierarchy } from "../../../src/features/watch/WatchHierarchy";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { FakeSequencedWatchRunner, FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
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

    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const result = await watchTapOn(deviceId, { action: "tap", text: "Accept", index }, undefined, {
      timer,
    });

    expect(result).toEqual({
      success: true,
      action: "tap",
      element: accept,
      effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
    });
    // Both captured Accept nodes have the same center in XCTest points.
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "hierarchy" },
      { type: "tap", x: 93.5, y: 131 },
      ...Array.from({ length: 8 }, () => ({ type: "hierarchy" as const })),
    ]);
  },
);

/** The captured permission alert after a crown turn scrolled its content up by `dy` points. */
function scrolledPermissionAlert(dy: number) {
  const tree = structuredClone(permissionAlert.data);
  const shift = (node: { bounds: { top: number; bottom: number }; children?: unknown }) => {
    node.bounds.top -= dy;
    node.bounds.bottom -= dy;
    (node.children as (typeof node)[] | null | undefined)?.forEach(shift);
  };
  const [alert] = tree.root.children;
  alert!.children?.forEach(shift);
  return tree;
}

test("turns the crown to bring the captured permission choice Allow on screen, then taps it", async () => {
  const client = new FakeSequencedWatchRunner([permissionAlert.data, scrolledPermissionAlert(82)]);
  unregister = watchRunners.register(deviceId, client);
  const button = elements(permissionAlert.data).find(
    (element) => element.text === "Allow" && element.class === "XCUIElementType(75)",
  );
  expect(button).toMatchObject({ bounds: { left: 0, top: 250, right: 187, bottom: 298 } });
  expect(permissionAlert.data.screenHeight).toBe(223);

  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const result = await watchTapOn(deviceId, { action: "tap", text: "Allow" }, undefined, {
    timer,
  });

  expect(result).toMatchObject({ success: true, element: { text: "Allow", bounds: { top: 168 } } });
  expect(client.commands.filter((command) => command.type !== "hierarchy")).toEqual([
    { type: "face", op: "dump" },
    { type: "crown", delta: 1, velocity: 1 },
    { type: "tap", x: 93.5, y: 192 },
  ]);
});

test.each([
  { text: "Allow", tap: undefined },
  { text: "Don’t Allow", tap: { type: "tap", x: 93.5, y: 213 } },
])(
  "taps only the visible part of the captured permission choice $text when the crown cannot scroll",
  async ({ text, tap }) => {
    const client = new FakeWatchRunnerClient(permissionAlert.data);
    unregister = watchRunners.register(deviceId, client);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();

    const action = watchTapOn(deviceId, { action: "tap", text }, undefined, { timer });
    if (tap) {
      await action;
    } else {
      await expect(action).rejects.toThrow(`The watch element "${text}" is off-screen`);
    }
    expect(client.commands.filter((command) => command.type !== "hierarchy")).toEqual([
      { type: "face", op: "dump" },
      { type: "crown", delta: 1, velocity: 1 },
      ...(tap ? [tap] : []),
    ]);
  },
);
