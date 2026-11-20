import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HealthKitSeeder,
  parseHealthProbeOutput,
  planHealthSheetTaps,
  type HealthAppRun,
  type HealthSheetUi,
  type HealthSimulatorRunner,
  type SheetElement,
} from "../../../src/utils/ios/healthKitSeeder";
import { HealthSeedError } from "../../../src/utils/ios/healthSeedError";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  HEALTHKIT_SEEDER_BUNDLE_ID,
  type HealthKitAppBuild,
  type HealthKitAppBuilder,
  HEALTHKIT_SEEDER_ENTITLEMENTS,
  HEALTHKIT_SEEDER_INFO_PLIST,
} from "../../../src/utils/ios/healthKitSeederApp";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/ios-healthkit", name), "utf8");

// Captured right after "Turn On All": the button already reads "Turn Off All".
const sheetAfterTurnOn = JSON.parse(
  fixture("health-access-sheet-after-turn-on-all-skeleton.json"),
) as SheetElement[];
// Captured with `observe` while the sheet first shows: "Turn On All", no Allow button on screen.
const sheetBeforeTurnOn = JSON.parse(
  fixture("health-access-sheet-initial-skeleton.json"),
) as SheetElement[];

const run1 = fixture("probe-run1-first-launch.txt");

type Deferred = { promise: Promise<string>; resolve: (output: string) => void };

function deferred(): Deferred {
  let resolve: (output: string) => void = () => undefined;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Like the real app, a launch prints `HKPROBE done` only after the sheet is accepted,
 * or straight away when it is already authorized (`completeOn: "launch"`), or when the
 * test releases it (`completeOn: "manual"`).
 */
class FakeRunner implements HealthSimulatorRunner {
  calls: string[] = [];
  private readonly pending: Array<{ udid: string; output: Deferred }> = [];
  constructor(
    private readonly output: string,
    private readonly completeOn: "launch" | "allow" | "manual",
  ) {}
  async install(udid: string, appPath: string): Promise<void> {
    this.calls.push(`install ${udid} ${appPath}`);
  }
  async terminate(udid: string, bundleId: string): Promise<void> {
    this.calls.push(`terminate ${udid} ${bundleId}`);
  }
  async launch(udid: string, bundleId: string, args: string[]): Promise<HealthAppRun> {
    this.calls.push(`launch ${udid} ${bundleId} ${args.join(" ")}`);
    const output = deferred();
    if (this.completeOn === "launch") {
      output.resolve(this.output);
    } else {
      this.pending.push({ udid, output });
    }
    return { waitForOutput: () => output.promise };
  }
  /** Finishes the oldest running launch (on `udid`, when given). */
  finish(udid?: string): void {
    const index = this.pending.findIndex((p) => udid === undefined || p.udid === udid);
    if (index >= 0) {
      this.pending.splice(index, 1)[0].output.resolve(this.output);
    }
  }
}

class FakeSheet implements HealthSheetUi {
  taps: string[] = [];
  polls = 0;
  onAllow: () => void = () => undefined;
  constructor(private readonly screens: SheetElement[][]) {}
  async elements(): Promise<SheetElement[]> {
    const screen = this.screens[Math.min(this.polls, this.screens.length - 1)];
    this.polls += 1;
    return screen;
  }
  async tapText(_udid: string, text: string): Promise<void> {
    this.taps.push(text);
    if (text === "Allow") {
      this.onAllow();
    }
  }
}

class FakeBuilder implements HealthKitAppBuilder {
  events: string[] = [];
  async build(): Promise<HealthKitAppBuild> {
    this.events.push("build");
    return {
      appPath: "/work/hkseeder.app",
      dispose: async () => {
        this.events.push("dispose");
      },
    };
  }
}

const hasSheet = (screens: SheetElement[][]): boolean =>
  screens.some((screen) => planHealthSheetTaps(screen).length > 0);

function seeder(
  output: string,
  screens: SheetElement[][],
  options: { sheetPolls?: number; completeOn?: "launch" | "allow" | "manual" } = {},
) {
  const runner = new FakeRunner(
    output,
    options.completeOn ?? (hasSheet(screens) ? "allow" : "launch"),
  );
  const sheet = new FakeSheet(screens);
  sheet.onAllow = () => runner.finish();
  const builder = new FakeBuilder();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const instance = new HealthKitSeeder({
    builder,
    runner,
    sheet,
    timer,
    sheetPolls: options.sheetPolls ?? 3,
  });
  return { instance, runner, sheet, timer, builder };
}

/** Lets queued promise chains (builds, lock hand-offs) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const savedOutput = (reads: string): string =>
  [
    "HKPROBE available=true args=[]",
    "HKPROBE requestAuthorization ok=true err=nil",
    "HKPROBE save ok=true err=nil",
    reads,
    "HKPROBE done",
    "",
  ].join("\n");

describe("parseHealthProbeOutput", () => {
  test("parses the captured first launch", () => {
    const report = parseHealthProbeOutput(run1);
    expect(report).toMatchObject({
      available: true,
      authorizationOk: true,
      authorizationError: null,
      saveOk: true,
      done: true,
    });
    expect(report.reads).toEqual({
      HKQuantityTypeIdentifierStepCount: 1,
      HKCategoryTypeIdentifierSleepAnalysis: 1,
      HKQuantityTypeIdentifierHeartRate: 1,
    });
  });

  test("keeps the not-determined errors captured before authorization", () => {
    const report = parseHealthProbeOutput(fixture("probe-before-authorization.txt"));
    expect(report.saveOk).toBe(false);
    expect(report.saveError).toContain("Code=5");
    expect(report.reads.HKQuantityTypeIdentifierStepCount).toBe(-1);
    expect(report.done).toBe(false);
  });

  test("parses a launch that skips requestAuthorization", () => {
    const report = parseHealthProbeOutput(fixture("probe-run3-noauth-readonly.txt"));
    expect(report.authorizationOk).toBeNull();
    expect(report.saveOk).toBeNull();
    expect(Object.values(report.reads)).toEqual([1, 1, 1]);
  });
});

describe("planHealthSheetTaps", () => {
  test("taps Turn On All then Allow on the captured sheet", () => {
    expect(planHealthSheetTaps(sheetBeforeTurnOn)).toEqual(["Turn On All", "Allow"]);
  });
  test("never taps Turn Off All", () => {
    expect(planHealthSheetTaps(sheetAfterTurnOn)).toEqual(["Allow"]);
  });
  test("the first-shown sheet has no Allow button yet", () => {
    expect(sheetBeforeTurnOn.some((e) => e.elementId === "UIA.Health.Allow.Button")).toBe(false);
  });
  test("does nothing without the sheet", () => {
    expect(planHealthSheetTaps([{ elementId: "other" }])).toEqual([]);
  });
});

describe("HealthKitSeeder", () => {
  test("installs, launches with the seed args, taps the sheet and reports the read-back", async () => {
    const { instance, runner, sheet } = seeder(run1, [sheetBeforeTurnOn]);
    const result = await instance.seed("UDID", { steps: 100, sleepHours: 6 });
    expect(runner.calls).toEqual([
      "install UDID /work/hkseeder.app",
      `terminate UDID ${HEALTHKIT_SEEDER_BUNDLE_ID}`,
      `launch UDID ${HEALTHKIT_SEEDER_BUNDLE_ID} steps=100 hr=72 sleepHours=6`,
    ]);
    expect(sheet.taps).toEqual(["Turn On All", "Allow"]);
    expect(result).toEqual({
      sheetAccepted: true,
      readBack: {
        HKQuantityTypeIdentifierStepCount: 1,
        HKQuantityTypeIdentifierHeartRate: 1,
        HKCategoryTypeIdentifierSleepAnalysis: 1,
      },
    });
  });

  test("polls with the timer until the sheet appears", async () => {
    const { instance, sheet, timer } = seeder(run1, [[], [], sheetBeforeTurnOn]);
    await instance.seed("UDID");
    expect(timer.getSleepHistory()).toEqual([500, 500]);
    expect(sheet.taps).toEqual(["Turn On All", "Allow"]);
  });

  test("an already-authorized app shows no sheet and still succeeds", async () => {
    const { instance, sheet } = seeder(run1, [[]]);
    const result = await instance.seed("UDID");
    expect(result.sheetAccepted).toBe(false);
    expect(sheet.taps).toEqual([]);
  });

  test("stops polling for the sheet once the app finishes without one", async () => {
    const { instance, sheet, timer } = seeder(run1, [[]], { sheetPolls: 20 });
    const result = await instance.seed("UDID");
    expect(result.sheetAccepted).toBe(false);
    expect(sheet.polls).toBe(1);
    expect(timer.getSleepCallCount()).toBeLessThanOrEqual(1);
  });

  test("removes the build after install, and when install fails", async () => {
    const ok = seeder(run1, [[]]);
    await ok.instance.seed("UDID");
    expect(ok.builder.events).toEqual(["build", "dispose"]);

    const failing = seeder(run1, [[]]);
    failing.runner.install = async () => {
      throw new Error("install failed");
    };
    await expect(failing.instance.seed("UDID")).rejects.toThrow("install failed");
    expect(failing.builder.events).toEqual(["build", "dispose"]);
  });

  test("serializes seeds on one simulator and keeps other simulators concurrent", async () => {
    const { instance, runner } = seeder(run1, [[]], { completeOn: "manual" });
    const first = instance.seed("LOCK-A");
    const second = instance.seed("LOCK-A");
    const other = instance.seed("LOCK-B");
    await settle();
    const installs = () => runner.calls.filter((c) => c.startsWith("install "));
    expect(installs()).toEqual([
      "install LOCK-A /work/hkseeder.app",
      "install LOCK-B /work/hkseeder.app",
    ]);

    runner.finish("LOCK-A");
    await first;
    await settle();
    expect(installs()).toHaveLength(3);

    runner.finish("LOCK-A");
    runner.finish("LOCK-B");
    await Promise.all([second, other]);
  });

  test("verification_failed when a read fails with an error other than not-determined", async () => {
    const out = savedOutput(
      [
        "HKPROBE read HKQuantityTypeIdentifierStepCount n=-1 err=Optional(Error Domain=com.apple.healthkit Code=3)",
        "HKPROBE read HKQuantityTypeIdentifierHeartRate n=1 err=nil",
        "HKPROBE read HKCategoryTypeIdentifierSleepAnalysis n=1 err=nil",
      ].join("\n"),
    );
    const { instance } = seeder(out, [[]]);
    const error = await instance.seed("UDID").catch((e) => e);
    expect(error).toBeInstanceOf(HealthSeedError);
    expect(error.code).toBe("verification_failed");
    expect(error.message).toContain("HKQuantityTypeIdentifierStepCount");
  });

  test("verification_failed when a seeded type has no read", async () => {
    const out = savedOutput("HKPROBE read HKQuantityTypeIdentifierStepCount n=1 err=nil");
    const { instance } = seeder(out, [[]]);
    const error = await instance.seed("UDID").catch((e) => e);
    expect(error.code).toBe("verification_failed");
    expect(error.message).toContain("HKQuantityTypeIdentifierHeartRate");
  });

  test("unavailable when HealthKit reports no health data", async () => {
    const { instance } = seeder("HKPROBE available=false args=[]\nHKPROBE done\n", [[]]);
    const error = await instance.seed("UDID").catch((e) => e);
    expect(error).toBeInstanceOf(HealthSeedError);
    expect(error.code).toBe("unavailable");
  });

  test("permission_denied when authorization is not determined", async () => {
    const out = `HKPROBE available=true args=[]\n${fixture("probe-before-authorization.txt")}HKPROBE done\n`;
    const { instance } = seeder(out, [[]]);
    const error = await instance.seed("UDID").catch((e) => e);
    expect(error.code).toBe("permission_denied");
  });

  test("unsupported for a non-positive value, before any build", async () => {
    const { instance, runner } = seeder(run1, [[]]);
    const error = await instance.seed("UDID", { steps: 0 }).catch((e) => e);
    expect(error.code).toBe("unsupported");
    expect(runner.calls).toEqual([]);
  });
});

describe("disposable app resources", () => {
  test("entitlements carry the HealthKit keys and application-identifier for the bundle", () => {
    expect(HEALTHKIT_SEEDER_ENTITLEMENTS).toContain(
      "<key>com.apple.developer.healthkit</key><true/>",
    );
    expect(HEALTHKIT_SEEDER_ENTITLEMENTS).toContain(`.${HEALTHKIT_SEEDER_BUNDLE_ID}</string>`);
    expect(HEALTHKIT_SEEDER_INFO_PLIST).toContain("NSHealthUpdateUsageDescription");
    expect(HEALTHKIT_SEEDER_INFO_PLIST).toContain(HEALTHKIT_SEEDER_BUNDLE_ID);
  });
});
