import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HealthKitSeeder,
  HealthSeedError,
  parseHealthProbeOutput,
  planHealthSheetTaps,
  type HealthAppRun,
  type HealthSheetUi,
  type HealthSimulatorRunner,
  type SheetElement,
} from "../../../src/utils/ios/healthKitSeeder";
import {
  HEALTHKIT_SEEDER_BUNDLE_ID,
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

class FakeRunner implements HealthSimulatorRunner {
  calls: string[] = [];
  constructor(private readonly output: string) {}
  async install(udid: string, appPath: string): Promise<void> {
    this.calls.push(`install ${udid} ${appPath}`);
  }
  async terminate(udid: string, bundleId: string): Promise<void> {
    this.calls.push(`terminate ${udid} ${bundleId}`);
  }
  async launch(udid: string, bundleId: string, args: string[]): Promise<HealthAppRun> {
    this.calls.push(`launch ${udid} ${bundleId} ${args.join(" ")}`);
    return { waitForOutput: async () => this.output };
  }
}

class FakeSheet implements HealthSheetUi {
  taps: string[] = [];
  polls = 0;
  constructor(private readonly screens: SheetElement[][]) {}
  async elements(): Promise<SheetElement[]> {
    const screen = this.screens[Math.min(this.polls, this.screens.length - 1)];
    this.polls += 1;
    return screen;
  }
  async tapText(_udid: string, text: string): Promise<void> {
    this.taps.push(text);
  }
}

function seeder(output: string, screens: SheetElement[][]) {
  const runner = new FakeRunner(output);
  const sheet = new FakeSheet(screens);
  const sleeps: number[] = [];
  const instance = new HealthKitSeeder({
    builder: { build: async () => "/work/hkseeder.app" },
    runner,
    sheet,
    timer: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    sheetPolls: 3,
  });
  return { instance, runner, sheet, sleeps };
}

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
    const { instance, sheet, sleeps } = seeder(run1, [[], [], sheetBeforeTurnOn]);
    await instance.seed("UDID");
    expect(sleeps).toEqual([500, 500]);
    expect(sheet.taps).toEqual(["Turn On All", "Allow"]);
  });

  test("an already-authorized app shows no sheet and still succeeds", async () => {
    const { instance, sheet } = seeder(run1, [[]]);
    const result = await instance.seed("UDID");
    expect(result.sheetAccepted).toBe(false);
    expect(sheet.taps).toEqual([]);
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
