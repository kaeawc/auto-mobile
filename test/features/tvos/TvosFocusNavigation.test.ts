import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeTvosRunnerClient } from "../../fakes/FakeTvosRunnerClient";
import { tvosTapOn } from "../../../src/features/tvos/TvosFocusNavigation";
import { tvosRunners } from "../../../src/features/tvos/TvosRunnerRegistry";
import type { TvosCommand, TVRemoteButton } from "../../../src/features/tvos/TvosRunnerClient";
import type { TapOnElementOptions } from "../../../src/models";
import { FocusAwareFakeTvosRunnerClient } from "../../fakes/FocusAwareFakeTvosRunnerClient";

const deviceId = "focus-navigation";
let client: FocusAwareFakeTvosRunnerClient;
let unregister: () => void;
beforeEach(() => {
  client = new FocusAwareFakeTvosRunnerClient();
  unregister = tvosRunners.register(deviceId, client);
});
afterEach(() => unregister());
const hierarchy: TvosCommand = { type: "request_hierarchy" };
const press = (action: TVRemoteButton): TvosCommand => ({ type: "request_press_button", action });

interface ReplayNode {
  "resource-id"?: string;
  text?: string;
  focused?: string;
  node?: ReplayNode[];
}

class CaptureReplayClient extends FakeTvosRunnerClient {
  private reads = 0;
  private readonly snapshots;

  constructor(vanish = false) {
    const snapshots = ["focus-field", "focus-b01"].map((name, index) => {
      const capture: { data: { hierarchy: ReplayNode } } = JSON.parse(
        readFileSync(
          path.join(
            import.meta.dir,
            "../../fixtures/tvos-xcuitest",
            `tvos-runner-hierarchy-${name}.json`,
          ),
          "utf8",
        ),
      );
      const adapt = (node: ReplayNode): void => {
        if (["B01", "B02"].includes(node["resource-id"] ?? "")) {
          node.text = "Repeated";
        }
        if (vanish && index === 1) {
          if (node["resource-id"] === "B02") {
            node.focused = "true";
          }
          node.node = node.node?.filter((child) => child["resource-id"] !== "B01");
        }
        node.node?.forEach(adapt);
      };
      adapt(capture.data.hierarchy);
      return new FakeTvosRunnerClient(capture.data).tree;
    });
    super(snapshots[0]);
    this.snapshots = snapshots;
  }

  override async hierarchy(signal?: AbortSignal) {
    await super.hierarchy(signal);
    return this.snapshots[Math.min(this.reads++, this.snapshots.length - 1)];
  }
}

test("keeps the ranked target when focus enlarges it in captured hierarchies", async () => {
  unregister();
  const replay = new CaptureReplayClient();
  unregister = tvosRunners.register(deviceId, replay);
  const result = await tvosTapOn(deviceId, { action: "tap", text: "Repeated", index: 0 });
  expect(replay.commands).toEqual([hierarchy, press("down"), hierarchy, press("select")]);
  expect(result.element?.["resource-id"]).toBe("B01");
  expect(result.element?.bounds).toEqual({ left: 901, top: 490, right: 1020, bottom: 564 });
});

test("fails instead of retargeting when the captured target disappears", async () => {
  unregister();
  const replay = new CaptureReplayClient(true);
  unregister = tvosRunners.register(deviceId, replay);
  const result = tvosTapOn(deviceId, { action: "tap", text: "Repeated", index: 0 });
  await expect(result).rejects.toBeInstanceOf(ActionableError);
  await expect(result).rejects.toThrow("target disappeared or became ambiguous");
  expect(replay.commands).toEqual([hierarchy, press("down"), hierarchy]);
});

test.each([
  ["B02", ["right"]],
  ["B21", ["down", "down"]],
  ["B22", ["down", "right", "down"]],
] as const)("moves through captured grid to %s then selects", async (elementId, moves) => {
  const result = await tvosTapOn(deviceId, { action: "tap", elementId });
  expect(result.success).toBe(true);
  expect(result.element?.["resource-id"]).toBe(elementId);
  expect(client.commands).toEqual([
    hierarchy,
    ...moves.flatMap((move) => [press(move), hierarchy]),
    press("select"),
  ]);
});

test("moves along a shelf from B10 to B12", async () => {
  client.focus("B10");
  await tvosTapOn(deviceId, { action: "tap", elementId: "B12" });
  expect(client.commands).toEqual([
    hierarchy,
    press("right"),
    hierarchy,
    press("right"),
    hierarchy,
    press("select"),
  ]);
});

test.each([{ elementId: "B01" }, { text: "B01" }, { elementId: "B01", text: "B01", index: 0 }])(
  "already-focused target uses only select: %j",
  async (selector) => {
    await tvosTapOn(deviceId, { action: "tap", ...selector });
    expect(client.commands).toEqual([hierarchy, press("select")]);
  },
);

test("index selects repeated captured text by smallest eligible area", async () => {
  for (const button of client.buttons) {
    button.text = "Repeated";
  }
  const result = await tvosTapOn(deviceId, { action: "tap", text: "Repeated", index: 1 });
  expect(result.element?.["resource-id"]).toBe("B21");
  expect(client.commands).toEqual([
    hierarchy,
    press("down"),
    hierarchy,
    press("down"),
    hierarchy,
    press("select"),
  ]);
});

test.each([{ text: "missing" }, { elementId: "B01", text: "B02" }, { text: "B01", index: 1 }, {}])(
  "no match fails without presses: %j",
  async (selector) => {
    await expect(tvosTapOn(deviceId, { action: "tap", ...selector })).rejects.toThrow(
      "No tvOS element matched",
    );
    expect(client.commands).toEqual([hierarchy]);
  },
);

test("offscreen target is excluded", async () => {
  client.buttons.find((button) => button["resource-id"] === "B22")!.bounds.left = -1;
  await expect(tvosTapOn(deviceId, { action: "tap", elementId: "B22" })).rejects.toThrow(
    "No tvOS element matched",
  );
  expect(client.commands).toEqual([hierarchy]);
});

test("nothing focused fails without presses", async () => {
  client.focus(undefined);
  await expect(tvosTapOn(deviceId, { action: "tap", text: "B22" })).rejects.toThrow(
    "Nothing is focused",
  );
  expect(client.commands).toEqual([hierarchy]);
});

test("focus trap tries both directions once and names focus and target", async () => {
  client.ignorePresses = true;
  await expect(tvosTapOn(deviceId, { action: "tap", text: "B22" })).rejects.toThrow(
    "focus stopped making progress from B01 toward B22",
  );
  expect(client.commands).toEqual([hierarchy, press("down"), hierarchy, press("right"), hierarchy]);
});

test("blocked primary direction falls back to the other axis", async () => {
  client.blockedActions.add("down");
  client.afterPress = () => client.blockedActions.clear();
  await tvosTapOn(deviceId, { action: "tap", text: "B22" });
  expect(client.commands).toEqual([
    hierarchy,
    press("down"),
    hierarchy,
    press("right"),
    hierarchy,
    press("down"),
    hierarchy,
    press("down"),
    hierarchy,
    press("select"),
  ]);
});

test("move budget has a distinct error and no extra press", async () => {
  await expect(tvosTapOn(deviceId, { action: "tap", text: "B22" }, undefined, 1)).rejects.toThrow(
    "exceeded maxMoves (1)",
  );
  expect(client.commands).toEqual([hierarchy, press("down"), hierarchy]);
});

test("can select at the exact move budget", async () => {
  await tvosTapOn(deviceId, { action: "tap", text: "B02" }, undefined, 1);
  expect(client.commands).toEqual([hierarchy, press("right"), hierarchy, press("select")]);
});

test("abort before navigation does no I/O", async () => {
  await expect(
    tvosTapOn(deviceId, { action: "tap", text: "B22" }, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(client.commands).toEqual([]);
});

test("abort after a press stops navigation", async () => {
  const controller = new AbortController();
  client.afterPress = () => controller.abort();
  await expect(
    tvosTapOn(deviceId, { action: "tap", text: "B22" }, controller.signal),
  ).rejects.toThrow();
  expect(client.commands).toEqual([hierarchy, press("down")]);
});

test.each<TapOnElementOptions>([
  { action: "longPress", text: "B01" },
  { action: "doubleTap", text: "B01" },
  { action: "focus", text: "B01" },
  { action: "tap", text: "B01", ensureChecked: false },
  { action: "tap", text: "B01", duration: 1 },
  { action: "tap", text: "B01", index: -1 },
  { action: "tap", text: "B01", index: 0.5 },
])("rejects unsupported options before reading hierarchy: %j", async (options) => {
  await expect(tvosTapOn(deviceId, options)).rejects.toThrow();
  expect(client.commands).toEqual([]);
});
