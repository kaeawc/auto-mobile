import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import {
  AdbTileProviderLister,
  TileProviderNotFoundError,
} from "../../../src/features/wear/TileProviders";
import type {
  AdbCommandRunner,
  AdbExecuteOptions,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";
import { ActionableError } from "../../../src/models";
import {
  capturedBroadcast as capturedReply,
  capturedFace,
  capturedTile,
} from "../../helpers/wearSurfaceCaptures";
import { surfaceSnapshot } from "../../../src/server/wearSurfaceTool";
import { FakeTimer } from "../../fakes/FakeTimer";

function reply(label: string): string {
  switch (label) {
    case "add-tile (ok)":
      return capturedReply("ops1.txt", `--es operation add-tile --ecn component ${FAVORITES}`);
    case "add-tile (index 1)":
      return capturedReply(
        "ops4-index-semantics.txt",
        `--es operation add-tile --ecn component ${FAVORITES}`,
      );
    case "add-tile (unknown provider)":
      return capturedReply("bc-noop.txt");
    case "add-tile (no component)":
      return capturedReply("ops1.txt", "--es operation add-tile");
    case "remove-tile (ok or absent)":
      return capturedReply("ops1.txt", `--es operation remove-tile --ecn component ${FAVORITES}`);
    case "remove-tile (no component)":
      return capturedReply("ops4-index-semantics.txt", "--es operation remove-tile");
    case "bogus":
      return capturedReply("ops1.txt", "--es operation bogus");
    case "show-tile on DEBUG_SURFACE":
      return capturedReply("ops1.txt", `--es operation show-tile --ecn component ${FAVORITES}`);
    case "show-tile on DEBUG_SYSUI (no index)":
      return capturedReply("ops3.txt", "--es operation show-tile");
    default:
      return capturedReply("ops3.txt", `--es operation show-tile --ei index ${label}`);
  }
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

/** `cmd package query-services --components` on the same emulator (#17496). */
const PROVIDERS = readFileSync(
  path.join(import.meta.dir, "../../fixtures/wear-tiles/query-services-components-api37.txt"),
  "utf8",
);

const FAVORITES =
  "com.google.android.contacts/com.google.android.wearable.contacts.tiles.FavoriteContactsTileService";
const WATCH_FACE = {
  ...surfaceSnapshot(capturedFace),
  appId: WEAR_SYSUI_PACKAGE,
  fingerprint: "watch-face",
};
let TILE: SurfaceSnapshot;
beforeAll(async () => {
  TILE = { ...surfaceSnapshot({ viewHierarchy: await capturedTile() }), appId: WEAR_SYSUI_PACKAGE };
});

let adb: FakeWearAdb;
let providerAdb: FakeWearAdb;
let timer: FakeTimer;
let screens: SurfaceSnapshot[];

function surface() {
  return new AdbWearSurface({
    adb,
    timer,
    observe: async () => screens.shift() ?? {},
    tileProviders: new AdbTileProviderLister(providerAdb),
  });
}

beforeEach(() => {
  adb = new FakeWearAdb();
  providerAdb = new FakeWearAdb();
  providerAdb.on(/query-services --components/, PROVIDERS);
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
    ["bogus", "show-tile", { code: 3, outcome: "unrecognizedOperation", operation: "bogus" }],
    ["99", "show-tile", { code: 1, outcome: "showRequested" }],
    ["show-tile on DEBUG_SYSUI (no index)", "show-tile", { code: 3, outcome: "indexRequired" }],
  ])("captured reply %s classifies", (label, operation, expected) => {
    expect(classifyBroadcast(operation, parseBroadcastOutput(reply(label)))).toMatchObject(
      expected,
    );
  });

  test.each(["0", "1", "99"])("captured show index %s is accepted without data", (index) => {
    expect(parseBroadcastOutput(reply(index))).toEqual({ code: 1 });
  });

  test("DEBUG_SURFACE does not support show-tile", () => {
    expect(
      classifyBroadcast("show-tile", parseBroadcastOutput(reply("show-tile on DEBUG_SURFACE"))),
    ).toMatchObject({ outcome: "unrecognizedOperation", operation: "show-tile" });
  });

  test("captured repeated add retains its index", () => {
    expect(
      parseBroadcastOutput(
        capturedReply(
          "ops4-index-semantics.txt",
          `--es operation add-tile --ecn component ${FAVORITES} --ei index 2`,
        ),
      ),
    ).toEqual(parseBroadcastOutput(reply("add-tile (index 1)")));
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

  test("listTileProviders reads the providers and broadcasts nothing", async () => {
    const result = await surface().listTileProviders();
    expect(providerAdb.commands).toEqual([
      "shell cmd package query-services --components -a androidx.wear.tiles.action.BIND_TILE_PROVIDER",
    ]);
    expect(adb.commands).toEqual([]);
    expect(result).toMatchObject({ success: true, action: "listTileProviders", verified: false });
    expect(result.providers.map((provider) => provider.component)).toEqual(
      PROVIDERS.trim().split("\n"),
    );
  });

  test("listTileProviders with none installed is an empty list, not an error", async () => {
    providerAdb = new FakeWearAdb();
    const result = await surface().listTileProviders();
    expect(result).toMatchObject({ success: true, providers: [] });
    expect(result.message).toMatch(/No tile providers/);
  });

  test("addTile of a component that is not a tile provider throws typed without broadcasting", async () => {
    adb.on(/operation add-tile/, reply("add-tile (ok)"));
    const call = surface().addTile("com.google.android.clockwork.sysui/x");
    await expect(call).rejects.toBeInstanceOf(TileProviderNotFoundError);
    await expect(call).rejects.toThrow(
      /is not a Wear tile provider.*Use one of: .*FavoriteContacts/,
    );
    expect(adb.commands).toEqual([]);
  });

  test("addTile accepts the short .Service form of a listed provider", async () => {
    providerAdb = new FakeWearAdb();
    providerAdb.on(/query-services/, "com.example/com.example.Tile\n");
    adb.on(/operation add-tile/, reply("add-tile (ok)"));
    const result = await surface().addTile("com.example/.Tile");
    expect(result.success).toBe(true);
    expect(adb.commands).toHaveLength(1);
  });

  test("a listed provider the broadcast still refuses keeps the typed broadcast outcome", async () => {
    // The listing is a snapshot: the provider can be disabled between the read and the broadcast.
    adb.on(/operation add-tile/, reply("add-tile (unknown provider)"));
    const result = await surface().addTile(FAVORITES);
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
    adb.on(/operation add-tile/, reply("add-tile (index 1)"));
    adb.on(/operation show-tile/, reply("1"));
    screens = [TILE];
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
    adb.on(/operation show-tile/, reply("99"));
    const afterTick = { ...WATCH_FACE, fingerprint: "clock-tick" };
    expect(afterTick.fingerprint).not.toBe(WATCH_FACE.fingerprint);
    screens = [afterTick];
    const result = await surface().showTile({ index: 99 });
    expect(result.broadcastResult.code).toBe(1);
    expect(result).toMatchObject({ success: false, verified: false, index: 99 });
    expect(result.reason).toMatch(/tile container/);
  });

  test("a tile already showing can be shown again", async () => {
    adb.on(/operation show-tile/, reply("0"));
    screens = [TILE];
    expect(await surface().showTile({ index: 0 })).toMatchObject({ success: true, verified: true });
  });

  test.each<[string, SurfaceSnapshot, RegExp]>([
    ["an unreadable screen", { appId: WEAR_SYSUI_PACKAGE }, /could not be read/],
    [
      "another app in front",
      { appId: "com.example", tileShowing: true },
      /com\.example, not the Wear system UI/,
    ],
  ])("showTile is not verified with %s", async (_label, after, reason) => {
    adb.on(/operation show-tile/, reply("0"));
    screens = [after];
    const result = await surface().showTile({ index: 0 });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  test("showTile of a component that is not a tile provider throws typed before any broadcast", async () => {
    const call = surface().showTile({ component: "com.example/.Missing" });
    await expect(call).rejects.toBeInstanceOf(TileProviderNotFoundError);
    expect(adb.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("showTile stops before showing when the index cannot be resolved", async () => {
    adb.on(/operation add-tile/, reply("add-tile (unknown provider)"));
    const result = await surface().showTile({ component: FAVORITES });
    expect(adb.commands).toHaveLength(1);
    expect(result).toMatchObject({
      success: false,
      verified: false,
      broadcastResult: { outcome: "providerNotFound" },
    });
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("a show-tile refusal is reported without waiting for an observe", async () => {
    adb.on(/operation show-tile/, reply("bogus"));
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
    const call = new AdbWearSurface({
      adb: failing,
      timer,
      observe: async () => ({}),
      tileProviders: new AdbTileProviderLister(failing),
    }).addTile(FAVORITES);
    await expect(call).rejects.toBeInstanceOf(ActionableError);
    await expect(call).rejects.toThrow(/device offline/);
  });
});
