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
import {
  itemId,
  ScrollingRowFakeTvosRunnerClient,
} from "../../fakes/ScrollingRowFakeTvosRunnerClient";

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

class SettingsReplayClient extends FakeTvosRunnerClient {
  private position: number;
  private readonly snapshots;

  constructor(start: number) {
    const capture: { snapshots: unknown[] } = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dir,
          "../../fixtures/tvos-xcuitest/tvos-runner-hierarchy-settings-focus-down.json",
        ),
        "utf8",
      ),
    );
    const snapshots = capture.snapshots.map((snapshot) => new FakeTvosRunnerClient(snapshot).tree);
    super(snapshots[start]);
    this.snapshots = snapshots;
    this.position = start;
  }

  override async request(
    command: TvosCommand,
    signal?: AbortSignal,
    options?: Parameters<FakeTvosRunnerClient["request"]>[2],
  ): Promise<unknown> {
    const result = await super.request(command, signal, options);
    if (command.type === "request_press_button") {
      this.position = Math.min(this.position + 1, this.snapshots.length - 1);
    }
    return result;
  }

  override async hierarchy(signal?: AbortSignal) {
    await super.hierarchy(signal);
    return this.snapshots[this.position];
  }
}

test.each([
  [1, "Accessibility", 1],
  [2, "Accessibility", 0],
  [3, "Developer", 2],
] as const)("replays Settings from snapshot %d to %s", async (start, text, moves) => {
  unregister();
  const replay = new SettingsReplayClient(start);
  unregister = tvosRunners.register(deviceId, replay);
  const result = await tvosTapOn(deviceId, { action: "tap", text });
  expect(result.success).toBe(true);
  expect(result.element?.text).toBe(text);
  expect(result.element?.class).toBe("75");
  expect(result.element?.focused).toBe("true");
  expect(replay.commands).toEqual([
    hierarchy,
    ...Array.from({ length: moves }, () => [press("down"), hierarchy]).flat(),
    press("select"),
  ]);
});

test("Settings focus animation labels do not occupy extra index slots", async () => {
  unregister();
  const replay = new SettingsReplayClient(2);
  unregister = tvosRunners.register(deviceId, replay);
  await expect(
    tvosTapOn(deviceId, { action: "tap", text: "Accessibility", index: 1 }, undefined, {
      maxSearchMoves: 0,
    }),
  ).rejects.toThrow("No tvOS element matched after searching 0 focus moves");
  expect(replay.commands).toEqual([hierarchy]);
});

test("index counts matching owners once while preserving label ranking", async () => {
  for (const button of client.buttons.filter((button) =>
    ["B01", "B02"].includes(button["resource-id"]),
  )) {
    button.text = "Repeated";
    const label = {
      ...button,
      "resource-id": "",
      className: "48",
      focused: "false",
      bounds: {
        left: button.bounds.left + 5,
        top: button.bounds.top + 5,
        right: button.bounds.left + 15,
        bottom: button.bounds.top + 15,
      },
      node: [],
    };
    button.node = [label, structuredClone(label)];
  }
  const result = await tvosTapOn(deviceId, { action: "tap", text: "Repeated", index: 1 });
  expect(result.element?.["resource-id"]).toBe("B02");
  expect(client.commands).toEqual([hierarchy, press("right"), hierarchy, press("select")]);
});

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

test.each([{ text: "missing" }, { elementId: "B01", text: "B02" }, { text: "B01", index: 1 }])(
  "no match with no search budget fails without presses: %j",
  async (selector) => {
    await expect(
      tvosTapOn(deviceId, { action: "tap", ...selector }, undefined, { maxSearchMoves: 0 }),
    ).rejects.toThrow("No tvOS element matched after searching 0 focus moves");
    expect(client.commands).toEqual([hierarchy]);
  },
);

test("an empty selector fails without searching", async () => {
  await expect(tvosTapOn(deviceId, { action: "tap" })).rejects.toThrow("No tvOS element matched");
  expect(client.commands).toEqual([hierarchy]);
});

test("a missing target sweeps every row and then fails without selecting", async () => {
  await expect(tvosTapOn(deviceId, { action: "tap", text: "missing" })).rejects.toThrow(
    "No tvOS element matched after searching the screen",
  );
  const presses = client.commands.filter((command) => command.type === "request_press_button");
  expect(presses.length).toBeLessThanOrEqual(60);
  expect(presses).not.toContainEqual(press("select"));
  expect(client.commands.at(-1)).toEqual(hierarchy);
});

test("the search still finds each edge while an unrelated label keeps changing", async () => {
  const label = client.nodes.find((node) => node["resource-id"] === "last")!;
  let tick = 0;
  client.afterPress = () => {
    label.text = `tick ${tick++}`;
  };
  await expect(tvosTapOn(deviceId, { action: "tap", text: "missing" })).rejects.toThrow(
    "No tvOS element matched after searching the screen",
  );
});

test("the search stops at its move budget", async () => {
  await expect(
    tvosTapOn(deviceId, { action: "tap", text: "missing" }, undefined, { maxSearchMoves: 2 }),
  ).rejects.toThrow("No tvOS element matched after searching 2 focus moves");
  expect(client.commands).toEqual([
    hierarchy,
    press("right"),
    hierarchy,
    press("right"),
    hierarchy,
  ]);
});

test("a target partly outside the screen bounds is still reached", async () => {
  client.buttons.find((button) => button["resource-id"] === "B22")!.bounds.left = -1;
  const result = await tvosTapOn(deviceId, { action: "tap", elementId: "B22" });
  expect(result.element?.["resource-id"]).toBe("B22");
  expect(client.commands.at(-1)).toEqual(press("select"));
});

const pressesOf = (commands: TvosCommand[]): string[] =>
  commands.flatMap((command) => (command.type === "request_press_button" ? [command.action] : []));

function registerRow(
  rows: number[],
  prefetch: number,
  label?: (row: number, column: number) => string,
  identifiers?: boolean,
): ScrollingRowFakeTvosRunnerClient {
  unregister();
  const row = new ScrollingRowFakeTvosRunnerClient({ rows, prefetch, label, identifiers });
  unregister = tvosRunners.register(deviceId, row);
  return row;
}

test("replays a row item in the second viewport that the hierarchy lists off screen", async () => {
  // Four 400-point cells fit on a 1920-point screen; item 6 starts at 2640.
  const row = registerRow([8], 2000);
  const result = await tvosTapOn(deviceId, { action: "tap", elementId: itemId(0, 6) });
  expect(result.element?.["resource-id"]).toBe(itemId(0, 6));
  expect(pressesOf(row.commands)).toEqual([...Array(6).fill("right"), "select"]);
  expect(row.focusedId).toBe(itemId(0, 6));
});

test("replays a row item in the second viewport that is not loaded yet", async () => {
  const row = registerRow([8], 0);
  const result = await tvosTapOn(deviceId, { action: "tap", elementId: itemId(0, 6) });
  expect(result.element?.["resource-id"]).toBe(itemId(0, 6));
  // Cells load as the row scrolls: the search moves right until item 6 appears, then navigation
  // finishes the approach.
  expect(pressesOf(row.commands)).toEqual([...Array(6).fill("right"), "select"]);
  expect(row.focusedId).toBe(itemId(0, 6));
});

test.each([2000, 0])(
  "a scrolled row whose cells have no identifiers still advances focus (prefetch %d)",
  async (prefetch) => {
    // Once the row scrolls, each newly focused cell sits at the same bounds at the viewport edge;
    // only its label tells the cells apart.
    const row = registerRow([8], prefetch, undefined, false);
    const result = await tvosTapOn(deviceId, { action: "tap", text: "Item 0-6" });
    expect(result.element?.text).toBe("Item 0-6");
    expect(pressesOf(row.commands)).toEqual([...Array(6).fill("right"), "select"]);
    expect(row.focusedId).toBe(itemId(0, 6));
  },
);

test("replays an unloaded item in a lower row by sweeping that row", async () => {
  const row = registerRow([3, 8], 0);
  const result = await tvosTapOn(deviceId, { action: "tap", text: "Item 1-6" });
  expect(result.element?.["resource-id"]).toBe(itemId(1, 6));
  expect(pressesOf(row.commands)).toEqual([
    "right",
    "right",
    "right",
    "left",
    "left",
    "left",
    "down",
    ...Array(6).fill("right"),
    "select",
  ]);
});

test("an on-screen match outranks an off-screen one for index 0", async () => {
  const row = registerRow([8], 2000, () => "Same");
  const result = await tvosTapOn(deviceId, { action: "tap", text: "Same" });
  expect(result.element?.["resource-id"]).toBe(itemId(0, 0));
  expect(pressesOf(row.commands)).toEqual(["select"]);
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

test("a refused press is detected while an unrelated label keeps changing", async () => {
  const label = client.buttons.find((button) => button["resource-id"] === "B00")!;
  let tick = 0;
  client.blockedActions.add("down");
  client.afterPress = () => {
    label.text = `tick ${tick++}`;
    if (client.buttons.find((button) => button.focused === "true")?.["resource-id"] !== "B01") {
      client.blockedActions.clear();
    }
  };
  await tvosTapOn(deviceId, { action: "tap", elementId: "B22" });
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
  await expect(
    tvosTapOn(deviceId, { action: "tap", text: "B22" }, undefined, { maxMoves: 1 }),
  ).rejects.toThrow("exceeded maxMoves (1)");
  expect(client.commands).toEqual([hierarchy, press("down"), hierarchy]);
});

test("can select at the exact move budget", async () => {
  await tvosTapOn(deviceId, { action: "tap", text: "B02" }, undefined, { maxMoves: 1 });
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
