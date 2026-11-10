import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AdbWatchFaceSurface,
  READBACK_ATTEMPTS,
  READBACK_INTERVAL_MS,
  WATCH_FACE_PATTERN,
  classifyFaceBroadcast,
  componentName,
} from "../../../src/features/wear/WatchFaceSurface";
import {
  parseComplicationProviders,
  type ComplicationProvider,
  type ComplicationProviderLister,
} from "../../../src/features/wear/ComplicationProviders";
import { DEBUG_SURFACE_ACTION, parseBroadcastOutput } from "../../../src/features/wear/WearSurface";
import { parseWatchFaces } from "../../../src/features/wear/wearServiceDumpsys";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";
import {
  capturedArrowReply,
  capturedReadback,
  capturedRuns,
  capturedSection,
} from "../../helpers/wearSurfaceCaptures";
import { FakeTimer } from "../../fakes/FakeTimer";

const OFFHAND = "com.google.wear.offhand";
const SUPERFICIAL = "com.google.wear.superficial";
const BATTERY =
  "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.BatteryProviderService";
const DAY_AND_DATE =
  "com.google.android.clockwork.sysui/com.google.android.clockwork.sysui.experiences.complications.providers.DayAndDateProviderService";
const BROADCAST = `shell am broadcast -a ${DEBUG_SURFACE_ACTION} --es operation`;

const FIXTURE_PROVIDER =
  "dev.jasonpearson.automobile.wearfixture/dev.jasonpearson.automobile.wearfixture.complication.FixtureComplicationService";
const HEART_RATE =
  "com.google.android.clockwork.emulator.complication.datasource/com.google.android.clockwork.emulator.complication.datasource.PlaceholderHeartRateProviderService";
/** The whole Offhand capture as-is: slot 11 empty (`type=1 provider=null`). */
const EMPTY_SLOT = "";

/** #17521 `query-services` capture, taken before the wear-fixture APK was installed. */
const CAPTURED_PROVIDERS = parseComplicationProviders(
  readFileSync(
    path.join(
      import.meta.dir,
      "../../fixtures/wear/surface/complication-providers-query-services.txt",
    ),
    "utf8",
  ),
);
const fixtureProvider = (label: string) =>
  capturedSection("complication-fixture-provider.txt", label);
const heartRate = (label: string) => capturedSection("complication-heart-rate.txt", label);
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

/**
 * Replays one captured reply per broadcast and captured readback excerpts in order (the last
 * repeats), each spliced into a whole `dumpsys wear_service` capture.
 */
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
    return exec(capturedReadback(next));
  }
}

class FakeProviderLister implements ComplicationProviderLister {
  calls = 0;
  constructor(public providers: ComplicationProvider[]) {}

  async list(): Promise<ComplicationProvider[]> {
    this.calls++;
    return this.providers;
  }
}

let adb: FakeWatchAdb;
let timer: FakeTimer;
let providers: FakeProviderLister;
const surface = () => new AdbWatchFaceSurface({ adb, timer, providers });

beforeEach(() => {
  adb = new FakeWatchAdb();
  providers = new FakeProviderLister(CAPTURED_PROVIDERS);
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

describe("captured readback excerpts read through parseWatchFaces", () => {
  const read = (excerpt: string) => parseWatchFaces(capturedReadback(excerpt));
  const liveSlots = (excerpt: string) =>
    read(excerpt)?.favorites.find((favorite) => favorite.favoriteId === 1)?.slots;

  test("an active-face excerpt names the active face and favorite", () => {
    expect(read(roundtrip("com.google.wear.superficial")[1] ?? "")?.activeFace).toEqual({
      package: SUPERFICIAL,
      favoriteId: 2,
      fallback: false,
    });
  });

  test("an excerpt without a favorite id leaves it unknown", () => {
    const [run] = capturedRuns("watchface-set-x10.txt");
    expect(read(run?.readback ?? "")?.activeFace).toMatchObject({ favoriteId: null });
  });

  test("a live config excerpt replaces that slot of the active favorite", () => {
    expect(liveSlots(complicationRuns[0]?.readback ?? "")).toEqual([
      { slot: 11, type: 5, provider: BATTERY },
      { slot: 12, type: 3, provider: DAY_AND_DATE },
    ]);
    expect(liveSlots(complicationRuns[1]?.readback ?? "")?.[0]).toEqual({
      slot: 11,
      type: 1,
      provider: null,
    });
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
    expect(result.readback?.activeFace.package).toBe(OFFHAND);
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
    adb.readbacks = [EMPTY_SLOT, set?.readback ?? ""];
    const request = { watchFace: OFFHAND, slot: 11, type: 5, provider: BATTERY };
    const result = await surface().setComplication(request);
    expect(adb.commands).toEqual([
      `${BROADCAST} set-complication --ecn component ${BATTERY} --es watchFaceId ${OFFHAND} --ei slot 11 --ei type 5`,
    ]);
    expect(result).toMatchObject({
      success: true,
      applied: true,
      change: "applied",
      favoriteId: 1,
      requested: request,
    });
  });

  test.each(["wrong type 1 (EMPTY) for battery on slot 11", "unsupported type 9 for battery"])(
    "captured %s: accepted but the empty slot stays empty, so unsupported_type",
    async (label) => {
      const [reply = "", readback = ""] = failures(label);
      adb.replies = [reply];
      adb.readbacks = [EMPTY_SLOT, readback];
      const type = label.includes("type 9") ? 9 : 1;
      const result = await surface().setComplication({
        watchFace: OFFHAND,
        slot: 11,
        type,
        provider: BATTERY,
      });
      expect(result.broadcastResult.accepted).toBe(true);
      expect(result).toMatchObject({ success: false, applied: false, error: "unsupported_type" });
      expect(result.change).toBeUndefined();
    },
  );

  test("a slot the face does not have is slot_out_of_range with only the pre-send read", async () => {
    adb.replies = [failures("slot 99")[0] ?? ""];
    const result = await surface().setComplication({
      watchFace: OFFHAND,
      slot: 99,
      type: 5,
      provider: BATTERY,
    });
    expect(result).toMatchObject({ success: false, error: "slot_out_of_range" });
    expect(result.reason).toMatch(/no complication slot/);
    expect(adb.reads).toBe(1);
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
    adb.readbacks = [
      complicationRuns[0]?.readback ?? "",
      complicationRuns[0]?.readback ?? "",
      unset?.readback ?? "",
    ];
    const result = await surface().unsetComplication({
      watchFace: OFFHAND,
      slot: 11,
      provider: BATTERY,
    });
    expect(adb.commands).toEqual([
      `${BROADCAST} unset-complication --ecn component ${BATTERY} --es watchFaceId ${OFFHAND} --ei slot 11`,
    ]);
    expect(result).toMatchObject({ success: true, applied: true, change: "applied" });
    expect(adb.reads).toBe(3);
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

  test("unsetComplication on a slot that was already empty is unchanged", async () => {
    adb.replies = [complicationRuns[1]?.reply ?? ""];
    adb.readbacks = [EMPTY_SLOT, complicationRuns[1]?.readback ?? ""];
    const result = await surface().unsetComplication({
      watchFace: OFFHAND,
      slot: 11,
      provider: BATTERY,
    });
    expect(result).toMatchObject({ success: true, applied: true, change: "unchanged" });
  });

  test("abort stops the readback poll", async () => {
    adb.replies = [roundtrip("com.google.wear.superficial")[0] ?? ""];
    adb.readbacks = [roundtrip("set offhand")[1] ?? ""];
    const controller = new AbortController();
    controller.abort();
    await expect(surface().setWatchFace(SUPERFICIAL, controller.signal)).rejects.toThrow();
  });
});

describe("setComplication provider check and change detection (#17521 captures)", () => {
  const request = (type: number, provider = FIXTURE_PROVIDER) => ({
    watchFace: OFFHAND,
    slot: 11,
    type,
    provider,
  });
  const withFixtureInstalled = () => {
    providers.providers = [
      ...CAPTURED_PROVIDERS,
      ...parseComplicationProviders(
        `      name=dev.jasonpearson.automobile.wearfixture.complication.FixtureComplicationService\n      packageName=dev.jasonpearson.automobile.wearfixture\n`,
      ),
    ];
  };

  test("the captured query-services list parses to its 14 services, without ApplicationInfo rows", () => {
    expect(CAPTURED_PROVIDERS).toHaveLength(14);
    expect(CAPTURED_PROVIDERS.map((p) => p.component)).toContain(BATTERY);
    expect(CAPTURED_PROVIDERS.map((p) => p.component)).toContain(HEART_RATE);
    expect(CAPTURED_PROVIDERS.some((p) => p.className.endsWith("ContactsApplication"))).toBe(false);
  });

  test("a provider that is not a data source fails before anything is sent", async () => {
    const result = await surface().setComplication(request(3));
    expect(result).toMatchObject({ success: false, applied: false, error: "provider_not_found" });
    expect(result.reason).toContain(BATTERY);
    expect(adb.commands).toEqual([]);
    expect(adb.reads).toBe(0);
  });

  test("with no data sources the refusal says to install one", async () => {
    providers.providers = [];
    const result = await surface().setComplication(request(5, BATTERY));
    expect(result).toMatchObject({ error: "provider_not_found" });
    expect(result.reason).toMatch(/No complication data sources are installed/);
  });

  test("unsetComplication does not list providers", async () => {
    adb.replies = [complicationRuns[1]?.reply ?? ""];
    adb.readbacks = [EMPTY_SLOT];
    await surface().unsetComplication({ watchFace: OFFHAND, slot: 11, provider: FIXTURE_PROVIDER });
    expect(providers.calls).toBe(0);
  });

  test("fixture type 3 onto the empty slot is applied", async () => {
    withFixtureInstalled();
    const [reply = "", readback = ""] = fixtureProvider("fixture type 3");
    adb.replies = [reply];
    adb.readbacks = [EMPTY_SLOT, readback];
    const result = await surface().setComplication(request(3));
    expect(result).toMatchObject({ success: true, applied: true, change: "applied" });
  });

  test("fixture type 5 over type 3 is applied", async () => {
    withFixtureInstalled();
    const [reply = "", readback = ""] = fixtureProvider("fixture type 5");
    adb.replies = [reply];
    adb.readbacks = [fixtureProvider("fixture type 3")[1] ?? "", readback];
    expect(await surface().setComplication(request(5))).toMatchObject({ change: "applied" });
  });

  test("fixture type 5 when the slot already shows type 5 is unchanged, not applied", async () => {
    withFixtureInstalled();
    const [reply = "", readback = ""] = fixtureProvider("fixture type 5");
    adb.replies = [reply];
    adb.readbacks = [readback, readback];
    const result = await surface().setComplication(request(5));
    expect(result).toMatchObject({ success: true, applied: true, change: "unchanged" });
    expect(result.message).toMatch(/nothing changed/);
  });

  test.each(["fixture type 4", "fixture type 9", "fixture type 1", "fixture type 6"])(
    "captured %s is ignored and the slot keeps type 5, so unsupported_type",
    async (label) => {
      withFixtureInstalled();
      const [reply = "", readback = ""] = fixtureProvider(label);
      adb.replies = [reply];
      adb.readbacks = [fixtureProvider("fixture type 5")[1] ?? "", readback];
      const result = await surface().setComplication(request(Number(label.split(" ").at(-1))));
      expect(result.broadcastResult.accepted).toBe(true);
      expect(result).toMatchObject({ success: false, applied: false, error: "unsupported_type" });
      expect(result.reason).toMatch(/SUPPORTED_TYPES/);
      expect(result.readback?.favorites[0]?.slots[0]).toEqual({
        slot: 11,
        type: 5,
        provider: FIXTURE_PROVIDER,
      });
    },
  );

  test("heart-rate type 5 over its type 3 is unsupported_type; type 6 is applied", async () => {
    adb.replies = [
      heartRate("heart-rate type 5")[0] ?? "",
      heartRate("heart-rate type 6")[0] ?? "",
    ];
    adb.readbacks = [
      heartRate("heart-rate type 3")[1] ?? "",
      heartRate("heart-rate type 5")[1] ?? "",
    ];
    const ignored = await surface().setComplication(request(5, HEART_RATE));
    expect(ignored.error).toBe("unsupported_type");
    adb.reads = 0;
    adb.readbacks = [
      heartRate("heart-rate type 5")[1] ?? "",
      heartRate("heart-rate type 6")[1] ?? "",
    ];
    const applied = await surface().setComplication(request(6, HEART_RATE));
    expect(applied).toMatchObject({ success: true, change: "applied" });
  });

  test("a slot that changed to something other than the request is not_applied", async () => {
    withFixtureInstalled();
    adb.replies = [fixtureProvider("fixture type 3")[0] ?? ""];
    adb.readbacks = [EMPTY_SLOT, heartRate("heart-rate type 3")[1] ?? ""];
    expect((await surface().setComplication(request(3))).error).toBe("not_applied");
  });

  test("without a readable pre-send slot, an apply carries no change verdict", async () => {
    withFixtureInstalled();
    const [reply = "", readback = ""] = fixtureProvider("fixture type 3");
    adb.replies = [reply];
    adb.readbacks = [new Error("device offline"), readback];
    const result = await surface().setComplication(request(3));
    expect(result).toMatchObject({ success: true, applied: true });
    expect(result.change).toBeUndefined();
  });
});
