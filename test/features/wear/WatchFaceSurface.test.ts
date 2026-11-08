import { beforeEach, describe, expect, test } from "bun:test";
import {
  AdbWatchFaceSurface,
  READBACK_ATTEMPTS,
  READBACK_INTERVAL_MS,
  WATCH_FACE_PATTERN,
  classifyFaceBroadcast,
  componentName,
} from "../../../src/features/wear/WatchFaceSurface";
import { DEBUG_SURFACE_ACTION, parseBroadcastOutput } from "../../../src/features/wear/WearSurface";
import { parseWatchFaceReading } from "../../../src/features/wear/wearServiceDumpsys";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";
import {
  capturedArrowReply,
  capturedRuns,
  capturedSection,
  capturedWearService,
} from "../../helpers/wearSurfaceCaptures";
import { FakeTimer } from "../../fakes/FakeTimer";

const OFFHAND = "com.google.wear.offhand";
const SUPERFICIAL = "com.google.wear.superficial";
const BATTERY =
  "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.BatteryProviderService";
const DAY_AND_DATE =
  "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.DayAndDateProviderService";
const BROADCAST = `shell am broadcast -a ${DEBUG_SURFACE_ACTION} --es operation`;

const failures = (label: string) => capturedSection("watchface-failures.txt", label);
const roundtrip = (label: string) => capturedSection("watchface-roundtrip.txt", label);
const complicationRuns = capturedRuns("complication-set-unset-x10.txt");
const classify = (stdout: string) => classifyFaceBroadcast(parseBroadcastOutput(stdout));

function exec(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s) => stdout.includes(s),
  };
}

/** Replays one captured reply per broadcast and captured readbacks in order (the last repeats). */
class FakeWatchAdb {
  readonly commands: string[] = [];
  reads = 0;
  replies: string[] = [];
  readbacks: Array<string | Error> = [];

  async executeCommand(command: string, _options?: AdbExecuteOptions): Promise<ExecResult> {
    this.commands.push(command);
    return exec(this.replies.shift() ?? "");
  }

  async execute(args: string[], _options?: AdbExecuteOptions): Promise<ExecResult> {
    expect(args).toEqual(["shell", "dumpsys", "wear_service"]);
    const next = this.readbacks[Math.min(this.reads++, this.readbacks.length - 1)] ?? "";
    if (next instanceof Error) {
      throw next;
    }
    return exec(next);
  }
}

let adb: FakeWatchAdb;
let timer: FakeTimer;
const surface = () => new AdbWatchFaceSurface({ adb, timer });

beforeEach(() => {
  adb = new FakeWatchAdb();
  timer = new FakeTimer();
  timer.enableAutoAdvance();
});

describe("watch face broadcast replies", () => {
  test.each([
    [roundtrip("com.google.wear.superficial")[0], { accepted: true, code: 1, favoriteId: 2 }],
    [failures("unset-watchface")[0], { accepted: true, favoriteId: 1 }],
    [capturedArrowReply("unset-complication --ecn component <provider>"), { favoriteId: 1 }],
    [failures("uninstalled package")[0], { code: 2, error: "face_not_installed" }],
    [failures("slot 99")[0], { code: 2, error: "slot_out_of_range" }],
    [roundtrip("com.google.wear.superficial/_placeholder_")[0], { error: "invalid_face_id" }],
    [failures("no key")[0], { code: 3, error: "missing_argument" }],
    [failures("both component and id")[0], { code: 3, error: "missing_argument" }],
    [failures("version")[0], { accepted: false, code: 1, error: "unknown_reply" }],
  ])("captured #17545 reply %s classifies", (stdout = "", expected) => {
    expect(classify(stdout)).toMatchObject(expected);
  });

  test.each([
    ["set-complication", "missing_argument"],
    ["set-complication --ecn component <provider>", "missing_argument"],
    ["set-complication ... --ecn watchface <face>", "missing_argument"],
    ["set-complication ... --ei slot 0", "missing_argument"],
    ["set-complication ... --ei slot 0 --ei type 3 (fallback face)", "unsupported_face"],
    [
      "set-complication ... --ecn watchface com.google.wear.offhand/_placeholder_ --ei slot 11 --ei type 3",
      "invalid_face_id",
    ],
    [
      "set-complication ... --ecn watchface com.google.wear.offhand/x --ei slot 11 --ei type 3",
      "face_not_installed",
    ],
    ["unset-complication (no extras)", "missing_argument"],
    ["unset-watchface (second call)", "watch_face_not_switched"],
  ])("captured #17520 reply %s is a typed refusal", (command, error) => {
    expect(classify(capturedArrowReply(command))).toMatchObject({ accepted: false, error });
  });

  test("the face pattern takes a bare package or package/class and refuses the rest", () => {
    for (const good of [OFFHAND, `${OFFHAND}/x`, "com.example/.Face"]) {
      expect(WATCH_FACE_PATTERN.test(good)).toBe(true);
    }
    for (const bad of [`${SUPERFICIAL}/`, `${SUPERFICIAL},null`, "a/b;reboot", "a b"]) {
      expect(WATCH_FACE_PATTERN.test(bad)).toBe(false);
    }
    expect(componentName("com.example/.Svc")).toBe("com.example/com.example.Svc");
  });
});

describe("dumpsys wear_service watch face reading", () => {
  test("a whole capture reads the active face, favorite and live slots", () => {
    expect(parseWatchFaceReading(capturedWearService())).toEqual({
      activeFace: { package: OFFHAND, className: null },
      favoriteId: 1,
      slots: [
        { slot: 11, type: 1, provider: null },
        { slot: 12, type: 3, provider: DAY_AND_DATE },
      ],
    });
  });

  test("captured readback excerpts parse the same way", () => {
    expect(parseWatchFaceReading(roundtrip("com.google.wear.superficial")[1] ?? "")).toEqual({
      activeFace: { package: SUPERFICIAL, className: null },
      favoriteId: 2,
      slots: [],
    });
    expect(parseWatchFaceReading(complicationRuns[0]?.readback ?? "").slots).toEqual([
      { slot: 11, type: 5, provider: BATTERY },
    ]);
    expect(parseWatchFaceReading("")).toEqual({ slots: [] });
  });
});

describe("AdbWatchFaceSurface", () => {
  test("setWatchFace sends watchFaceId as a string extra and confirms it on readback", async () => {
    const [reply = "", readback = ""] = roundtrip("com.google.wear.superficial");
    adb.replies = [reply];
    adb.readbacks = [readback];
    const result = await surface().setWatchFace(SUPERFICIAL);
    expect(adb.commands).toEqual([`${BROADCAST} set-watchface --es watchFaceId ${SUPERFICIAL}`]);
    expect(result).toMatchObject({
      success: true,
      action: "setWatchFace",
      requested: { watchFace: SUPERFICIAL },
      applied: true,
      verified: true,
      favoriteId: 2,
    });
  });

  test.each(capturedRuns("watchface-set-x10.txt"))(
    "captured set-watchface $run is applied",
    async ({ run, reply, readback }) => {
      adb.replies = [reply];
      adb.readbacks = [readback];
      const face = run.split(" ")[1] ?? "";
      expect((await surface().setWatchFace(face)).applied).toBe(true);
    },
  );

  test("a lagging readback is polled with the injected timer until it shows the face", async () => {
    adb.replies = [roundtrip("com.google.wear.superficial")[0] ?? ""];
    adb.readbacks = [
      roundtrip("set offhand")[1] ?? "",
      roundtrip("com.google.wear.superficial")[1] ?? "",
    ];
    expect((await surface().setWatchFace(SUPERFICIAL)).applied).toBe(true);
    expect(timer.getSleepHistory()).toEqual([READBACK_INTERVAL_MS]);
  });

  test("an accepted face that never reads back is not_applied", async () => {
    adb.replies = [roundtrip("com.google.wear.superficial")[0] ?? ""];
    adb.readbacks = [roundtrip("set offhand")[1] ?? ""];
    const result = await surface().setWatchFace(SUPERFICIAL);
    expect(result).toMatchObject({ success: false, applied: false, error: "not_applied" });
    expect(result.readback?.activeFace?.package).toBe(OFFHAND);
    expect(adb.reads).toBe(READBACK_ATTEMPTS);
  });

  test("an unreadable dumpsys is reported, not mistaken for a change", async () => {
    adb.replies = [roundtrip("com.google.wear.superficial")[0] ?? ""];
    adb.readbacks = [new Error("device offline")];
    const result = await surface().setWatchFace(SUPERFICIAL);
    expect(result).toMatchObject({ applied: false, error: "not_applied" });
    expect(result.readback).toBeUndefined();
    expect(result.reason).toMatch(/could not be read/);
  });

  test("a classic face goes through component for set-watchface", async () => {
    adb.replies = [
      failures("set-watchface via ecn component pkg/cls (classic style) on resource-only")[0] ?? "",
    ];
    const result = await surface().setWatchFace(`${OFFHAND}/x`);
    expect(adb.commands).toEqual([`${BROADCAST} set-watchface --ecn component ${OFFHAND}/x`]);
    expect(result).toMatchObject({ success: false, error: "face_not_installed" });
    expect(adb.reads).toBe(0);
  });

  test("a placeholder class is refused before anything is sent", async () => {
    const result = await surface().setWatchFace(`${SUPERFICIAL}/_placeholder_`);
    expect(result).toMatchObject({ success: false, error: "invalid_face_id" });
    expect(adb.commands).toEqual([]);
  });

  test("setComplication on a WFF face is applied when the slot shows the provider and type", async () => {
    const [set] = complicationRuns;
    adb.replies = [set?.reply ?? ""];
    adb.readbacks = [set?.readback ?? ""];
    const request = { watchFace: OFFHAND, slot: 11, type: 5, provider: BATTERY };
    const result = await surface().setComplication(request);
    expect(adb.commands).toEqual([
      `${BROADCAST} set-complication --ecn component ${BATTERY} --es watchFaceId ${OFFHAND} --ei slot 11 --ei type 5`,
    ]);
    expect(result).toMatchObject({
      success: true,
      applied: true,
      favoriteId: 1,
      requested: request,
    });
  });

  test.each(["wrong type 1 (EMPTY) for battery on slot 11", "unsupported type 9 for battery"])(
    "captured %s: accepted but the slot stays empty, so not_applied",
    async (label) => {
      const [reply = "", readback = ""] = failures(label);
      adb.replies = [reply];
      adb.readbacks = [readback];
      const type = label.includes("type 9") ? 9 : 1;
      const result = await surface().setComplication({
        watchFace: OFFHAND,
        slot: 11,
        type,
        provider: BATTERY,
      });
      expect(result.broadcastResult.accepted).toBe(true);
      expect(result).toMatchObject({ success: false, applied: false, error: "not_applied" });
    },
  );

  test("a slot the face does not have is slot_out_of_range without a readback", async () => {
    adb.replies = [failures("slot 99")[0] ?? ""];
    const result = await surface().setComplication({
      watchFace: OFFHAND,
      slot: 99,
      type: 5,
      provider: BATTERY,
    });
    expect(result).toMatchObject({ success: false, error: "slot_out_of_range" });
    expect(result.reason).toMatch(/no complication slot/);
    expect(adb.reads).toBe(0);
  });

  test("a classic face goes through --ecn watchface for set-complication", async () => {
    adb.replies = [
      capturedArrowReply(
        "set-complication ... --ecn watchface com.google.wear.offhand/x --ei slot 11 --ei type 3",
      ),
    ];
    const result = await surface().setComplication({
      watchFace: `${OFFHAND}/x`,
      slot: 11,
      type: 3,
      provider: BATTERY,
    });
    expect(adb.commands[0]).toBe(
      `${BROADCAST} set-complication --ecn component ${BATTERY} --ecn watchface ${OFFHAND}/x --ei slot 11 --ei type 3`,
    );
    expect(result.error).toBe("face_not_installed");
  });

  test("the fallback face is unsupported_face", async () => {
    adb.replies = [
      capturedArrowReply("set-complication ... --ei slot 0 --ei type 3 (fallback face)"),
    ];
    const result = await surface().setComplication({
      watchFace: `${OFFHAND}/x`,
      slot: 0,
      type: 3,
      provider: BATTERY,
    });
    expect(result).toMatchObject({ success: false, error: "unsupported_face" });
  });

  test("unsetComplication is applied when the slot reads back empty", async () => {
    const unset = complicationRuns[1];
    adb.replies = [unset?.reply ?? ""];
    adb.readbacks = [complicationRuns[0]?.readback ?? "", unset?.readback ?? ""];
    const result = await surface().unsetComplication({
      watchFace: OFFHAND,
      slot: 11,
      provider: BATTERY,
    });
    expect(adb.commands).toEqual([
      `${BROADCAST} unset-complication --ecn component ${BATTERY} --es watchFaceId ${OFFHAND} --ei slot 11`,
    ]);
    expect(result).toMatchObject({ success: true, applied: true });
    expect(adb.reads).toBe(2);
  });

  test("unsetWatchFace confirms the reply's favorite is active again", async () => {
    const [reply = "", readback = ""] = failures("unset-watchface");
    adb.replies = [reply];
    adb.readbacks = [readback];
    const result = await surface().unsetWatchFace();
    expect(adb.commands).toEqual([`${BROADCAST} unset-watchface`]);
    expect(result).toMatchObject({ success: true, applied: true, favoriteId: 1 });
  });

  test("a second unsetWatchFace is watch_face_not_switched", async () => {
    adb.replies = [capturedArrowReply("unset-watchface (second call)")];
    const result = await surface().unsetWatchFace();
    expect(result).toMatchObject({ success: false, error: "watch_face_not_switched" });
  });

  test("abort stops the readback poll", async () => {
    adb.replies = [roundtrip("com.google.wear.superficial")[0] ?? ""];
    adb.readbacks = [roundtrip("set offhand")[1] ?? ""];
    const controller = new AbortController();
    controller.abort();
    await expect(surface().setWatchFace(SUPERFICIAL, controller.signal)).rejects.toThrow();
  });
});
