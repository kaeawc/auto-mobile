import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AdbWearSurface,
  DEBUG_SURFACE_ACTION,
  DEBUG_SYSUI_ACTION,
  SHOW_TILE_SETTLE_MS,
  TILE_COMPONENT_PATTERN,
  WEAR_SYSUI_PACKAGE,
  classifyBroadcast,
  parseBroadcastOutput,
  type SurfaceSnapshot,
} from "../../../src/features/wear/WearSurface";
import type {
  AdbCommandRunner,
  AdbExecuteOptions,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";
import { ActionableError } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const FIXTURES = path.join(import.meta.dir, "../../fixtures/wear/surface");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

/** Trailing `result=<n>[, data="..."]` of a transcript line, without the capture's annotations. */
const REPLY_TAIL = /result=-?\d+(?:, data="[^"]*")?/;

/** The `Broadcast completed:` line a transcript row records. */
function completedLine(line: string): string {
  const tail = REPLY_TAIL.exec(line);
  if (!tail) {
    throw new Error(`transcript line has no reply: ${line}`);
  }
  return `Broadcast completed: ${tail[0]}`;
}

/** broadcast-replies.txt: `<label>  result=...` rows captured on the Wear OS 7 emulator (#16824). */
function replies(): Map<string, string> {
  return new Map(
    fixture("broadcast-replies.txt")
      .split("\n")
      .filter((line) => line.includes("result="))
      .map((line) => [
        line.slice(0, line.indexOf("result=")).trim().replace(/\s+/g, " "),
        completedLine(line),
      ]),
  );
}

const REPLIES = replies();
function reply(label: string): string {
  const stdout = REPLIES.get(label);
  if (stdout === undefined) {
    throw new Error(`no fixture reply "${label}"; have ${[...REPLIES.keys()].join(" | ")}`);
  }
  // `am broadcast` prints the intent line before the completed line.
  return `Broadcasting: Intent { flg=0x400000 (has extras) }\n${stdout}\n`;
}

function exec(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s) => stdout.includes(s),
  };
}

/** Fake adb that replays captured broadcast replies; unmatched commands print nothing. */
class FakeWearAdb implements AdbCommandRunner {
  readonly commands: string[] = [];
  private readonly rules: Array<{ pattern: RegExp; stdout: () => string }> = [];

  async executeCommand(command: string, _options?: AdbExecuteOptions): Promise<ExecResult> {
    this.commands.push(command);
    const rule = this.rules.find((candidate) => candidate.pattern.test(command));
    return exec(rule ? rule.stdout() : "");
  }

  on(pattern: RegExp, stdout: string | (() => string)) {
    this.rules.push({ pattern, stdout: typeof stdout === "string" ? () => stdout : stdout });
  }
}

const FAVORITES =
  "com.google.android.contacts/com.google.android.wearable.contacts.tiles.FavoriteContactsTileService";
const WATCH_FACE: SurfaceSnapshot = { appId: WEAR_SYSUI_PACKAGE, fingerprint: "watch-face" };
const TILE: SurfaceSnapshot = { appId: WEAR_SYSUI_PACKAGE, fingerprint: "favorites-tile" };

let adb: FakeWearAdb;
let timer: FakeTimer;
let screens: SurfaceSnapshot[];

function surface() {
  return new AdbWearSurface({
    adb,
    timer,
    observe: async () => screens.shift() ?? {},
  });
}

beforeEach(() => {
  adb = new FakeWearAdb();
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  screens = [];
});

describe("broadcast reply parser", () => {
  test.each<[string, "add-tile" | "remove-tile" | "show-tile", object]>([
    ["add-tile (ok)", "add-tile", { code: 1, outcome: "added", index: 0, data: "Index=[0]" }],
    ["add-tile (unknown provider)", "add-tile", { code: 2, outcome: "providerNotFound" }],
    ["add-tile (no component)", "add-tile", { code: 3, outcome: "missingComponent" }],
    ["remove-tile (ok or absent)", "remove-tile", { code: 1, outcome: "removed" }],
    ["remove-tile (no component)", "remove-tile", { code: 3, outcome: "missingComponent" }],
    [
      "<any op unknown to the action>",
      "show-tile",
      { code: 3, outcome: "unrecognizedOperation", operation: "<op>" },
    ],
    [
      "show-tile on DEBUG_SYSUI (ok, also index 99)",
      "show-tile",
      { code: 1, outcome: "showRequested" },
    ],
    ["show-tile on DEBUG_SYSUI (no index)", "show-tile", { code: 3, outcome: "indexRequired" }],
  ])("captured reply %s classifies", (label, operation, expected) => {
    expect(classifyBroadcast(operation, parseBroadcastOutput(reply(label)))).toMatchObject(
      expected,
    );
  });

  test("every captured fixture row is covered", () => {
    expect(REPLIES.size).toBe(8);
  });

  test("every reply in the captured adb sessions parses to a known outcome", () => {
    const lines = [
      ...fixture("debug-surface-session.txt").split("\n"),
      ...fixture("debug-sysui-session.txt").split("\n"),
    ].filter((line) => line.includes("result="));
    // The operation each captured reply answered, in transcript order.
    const operations = [
      "add-tile",
      "add-tile",
      "add-tile",
      "remove-tile",
      "add-tile",
      "show-tile",
      "show-tile",
      "show-tile",
      "show-tile",
    ] as const;
    expect(lines).toHaveLength(operations.length);
    const outcomes = lines.map(
      (line, i) =>
        classifyBroadcast(operations[i], parseBroadcastOutput(completedLine(line))).outcome,
    );
    expect(outcomes).toEqual([
      "added",
      "providerNotFound",
      "missingComponent",
      "removed",
      "unrecognizedOperation",
      "unrecognizedOperation",
      "showRequested",
      "indexRequired",
      "showRequested",
    ]);
  });

  test("a reply the release does not know is unknown, never a guessed success", () => {
    expect(classifyBroadcast("add-tile", parseBroadcastOutput("")).outcome).toBe("unknown");
    expect(
      classifyBroadcast(
        "add-tile",
        parseBroadcastOutput('Broadcast completed: result=1, data="ok"'),
      ).outcome,
    ).toBe("unknown");
    expect(
      classifyBroadcast("remove-tile", parseBroadcastOutput("Broadcast completed: result=0"))
        .outcome,
    ).toBe("unknown");
    expect(parseBroadcastOutput("Broadcast completed: result=1\r\n")).toEqual({ code: 1 });
  });

  test("the component pattern accepts provider names and refuses shell metacharacters", () => {
    expect(TILE_COMPONENT_PATTERN.test(FAVORITES)).toBe(true);
    expect(TILE_COMPONENT_PATTERN.test("com.example/.tiles.MyTile")).toBe(true);
    for (const bad of ["com.example", "a/b;reboot", "a/$(id)", "a/b c", "/b"]) {
      expect(TILE_COMPONENT_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("AdbWearSurface", () => {
  test("addTile sends add-tile on DEBUG_SURFACE and reports the index without claiming an observe", async () => {
    adb.on(/operation add-tile/, reply("add-tile (ok)"));
    const result = await surface().addTile(FAVORITES);
    expect(adb.commands).toEqual([
      `shell am broadcast -a ${DEBUG_SURFACE_ACTION} --es operation add-tile --ecn component ${FAVORITES}`,
    ]);
    expect(result).toMatchObject({
      success: true,
      action: "addTile",
      requested: { component: FAVORITES },
      index: 0,
      verified: false,
    });
    expect(result.message).toMatch(/idempotent/);
  });

  test("addTile of an unknown provider fails with a typed outcome", async () => {
    adb.on(/operation add-tile/, reply("add-tile (unknown provider)"));
    const result = await surface().addTile("com.google.android.clockwork.sysui/x");
    expect(result.success).toBe(false);
    expect(result.broadcastResult.outcome).toBe("providerNotFound");
    expect(result.index).toBeUndefined();
    expect(result.reason).toMatch(/does not exist/);
  });

  test("removeTile reports removed-or-absent, never a confirmed removal", async () => {
    adb.on(/operation remove-tile/, reply("remove-tile (ok or absent)"));
    const result = await surface().removeTile(FAVORITES);
    expect(adb.commands[0]).toContain(`-a ${DEBUG_SURFACE_ACTION} --es operation remove-tile`);
    expect(result).toMatchObject({ success: true, verified: false });
    expect(result.message).toMatch(/removed or was not present/);
  });

  test("showTile by component resolves the index right before showing and verifies by observe", async () => {
    // Indexes shift: Favorites was pushed to 1 by a later add (#16824).
    adb.on(/operation add-tile/, reply("add-tile (ok)").replace("Index=[0]", "Index=[1]"));
    adb.on(/operation show-tile/, reply("show-tile on DEBUG_SYSUI (ok, also index 99)"));
    screens = [WATCH_FACE, TILE];
    const result = await surface().showTile({ component: FAVORITES });
    expect(adb.commands).toEqual([
      `shell am broadcast -a ${DEBUG_SURFACE_ACTION} --es operation add-tile --ecn component ${FAVORITES}`,
      `shell am broadcast -a ${DEBUG_SYSUI_ACTION} --es operation show-tile --ei index 1`,
    ]);
    expect(timer.getSleepHistory()).toEqual([SHOW_TILE_SETTLE_MS]);
    expect(result).toMatchObject({
      success: true,
      verified: true,
      index: 1,
      requested: { component: FAVORITES },
      broadcastResult: { outcome: "showRequested" },
      indexResolution: { outcome: "added", index: 1 },
    });
  });

  test("an out-of-range index is accepted by the broadcast but not verified", async () => {
    adb.on(/operation show-tile/, reply("show-tile on DEBUG_SYSUI (ok, also index 99)"));
    screens = [WATCH_FACE, WATCH_FACE];
    const result = await surface().showTile({ index: 99 });
    expect(result.broadcastResult.code).toBe(1);
    expect(result).toMatchObject({ success: false, verified: false, index: 99 });
    expect(result.reason).toMatch(/did not change/);
  });

  test.each<[string, SurfaceSnapshot, SurfaceSnapshot, RegExp]>([
    ["an unreadable screen", {}, TILE, /could not be read/],
    [
      "another app in front",
      WATCH_FACE,
      { appId: "com.example", fingerprint: "x" },
      /com\.example, not the Wear system UI/,
    ],
  ])("showTile is not verified with %s", async (_label, before, after, reason) => {
    adb.on(/operation show-tile/, reply("show-tile on DEBUG_SYSUI (ok, also index 99)"));
    screens = [before, after];
    const result = await surface().showTile({ index: 0 });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  test("showTile stops before showing when the index cannot be resolved", async () => {
    adb.on(/operation add-tile/, reply("add-tile (unknown provider)"));
    const result = await surface().showTile({ component: "com.example/.Missing" });
    expect(adb.commands).toHaveLength(1);
    expect(result).toMatchObject({
      success: false,
      verified: false,
      broadcastResult: { outcome: "providerNotFound" },
    });
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("a show-tile refusal is reported without waiting for an observe", async () => {
    adb.on(/operation show-tile/, reply("<any op unknown to the action>"));
    screens = [WATCH_FACE];
    const result = await surface().showTile({ index: 0 });
    expect(result.broadcastResult.outcome).toBe("unrecognizedOperation");
    expect(result.success).toBe(false);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("an adb failure becomes an actionable error", async () => {
    const failing: AdbCommandRunner = {
      executeCommand: async () => {
        throw new Error("device offline");
      },
    };
    const call = new AdbWearSurface({ adb: failing, timer, observe: async () => ({}) }).addTile(
      FAVORITES,
    );
    await expect(call).rejects.toBeInstanceOf(ActionableError);
    await expect(call).rejects.toThrow(/device offline/);
  });
});
