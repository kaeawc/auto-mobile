import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import { logger } from "../logger";
import type { ExecFileAsync } from "../HostCommandExecutor";
import type { Timer } from "../SystemTimer";
import { HEALTHKIT_SEEDER_BUNDLE_ID, type HealthKitAppBuilder } from "./healthKitSeederApp";

/** Typed failures of the health seeding contract (#14215, #18801). */
export type HealthSeedErrorCode = "unavailable" | "permission_denied" | "unsupported";

export class HealthSeedError extends ActionableError {
  constructor(
    readonly code: HealthSeedErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "HealthSeedError";
  }
}

export interface HealthSeedRequest {
  /** Step count for the last hour. Default 4242. */
  steps?: number;
  /** Heart rate in count/min. Default 72. */
  heartRate?: number;
  /** Length of the sleep sample ending an hour ago. Default 8. */
  sleepHours?: number;
}

export interface HealthSeedResult {
  /** Whether the Health Access sheet was shown and accepted (false when already authorized). */
  sheetAccepted: boolean;
  /** Sample counts read back per HealthKit type identifier. */
  readBack: Record<string, number>;
}

export interface HealthProbeReport {
  available: boolean;
  authorizationOk: boolean | null;
  authorizationError: string | null;
  saveOk: boolean | null;
  saveError: string | null;
  /** Sample count per type; -1 when the read failed. */
  reads: Record<string, number>;
  readErrors: Record<string, string>;
  done: boolean;
}

const LINE = /^HKPROBE (.*)$/;

function errorText(raw: string): string | null {
  return raw === "nil" ? null : raw;
}

/** Parses the `HKPROBE` stdout lines printed by the disposable seeding app. */
export function parseHealthProbeOutput(output: string): HealthProbeReport {
  const report: HealthProbeReport = {
    available: false,
    authorizationOk: null,
    authorizationError: null,
    saveOk: null,
    saveError: null,
    reads: {},
    readErrors: {},
    done: false,
  };
  for (const raw of output.split(/\r?\n/)) {
    const body = LINE.exec(raw)?.[1];
    if (body === undefined) {
      continue;
    }
    if (body === "done") {
      report.done = true;
    } else if (body.startsWith("available=")) {
      report.available = body.startsWith("available=true");
    } else if (body.startsWith("requestAuthorization ")) {
      const m = /^requestAuthorization ok=(true|false) err=(.*)$/.exec(body);
      report.authorizationOk = m?.[1] === "true";
      report.authorizationError = errorText(m?.[2] ?? "");
    } else if (body.startsWith("save ")) {
      const m = /^save ok=(true|false) err=(.*)$/.exec(body);
      report.saveOk = m?.[1] === "true";
      report.saveError = errorText(m?.[2] ?? "");
    } else if (body.startsWith("read ")) {
      const m = /^read (\S+) n=(-?\d+) err=(.*)$/.exec(body);
      if (m) {
        report.reads[m[1]] = Number(m[2]);
        const err = errorText(m[3]);
        if (err) {
          report.readErrors[m[1]] = err;
        }
      }
    }
  }
  return report;
}

export interface SheetElement {
  elementId?: string;
  label?: string;
}

export const HEALTH_SHEET_IDS = {
  allCategory: "UIA.Health.AuthSheet.AllCategoryButton",
  allow: "UIA.Health.Allow.Button",
} as const;

/** Which taps the Health Access sheet currently needs; empty when it is not shown. */
export function planHealthSheetTaps(elements: readonly SheetElement[]): string[] {
  const all = elements.find((e) => e.elementId === HEALTH_SHEET_IDS.allCategory);
  const allow = elements.some((e) => e.elementId === HEALTH_SHEET_IDS.allow);
  if (!all && !allow) {
    return [];
  }
  // The Allow button is off screen until "Turn On All" is tapped. The category button
  // reads "Turn Off All" once everything is on: tapping it would revoke access.
  return all?.label === "Turn On All" ? ["Turn On All", "Allow"] : ["Allow"];
}

/** Reads the simulator UI and taps by text, in-simulator only. */
export interface HealthSheetUi {
  elements(udid: string): Promise<SheetElement[]>;
  tapText(udid: string, text: string): Promise<void>;
}

export interface HealthAppRun {
  /** Resolves with the app's stdout once it prints `HKPROBE done`; rejects on timeout. */
  waitForOutput(): Promise<string>;
}

export interface HealthSimulatorRunner {
  install(udid: string, appPath: string): Promise<void>;
  launch(udid: string, bundleId: string, args: string[]): Promise<HealthAppRun>;
  terminate(udid: string, bundleId: string): Promise<void>;
}

export interface HealthKitSeederOptions {
  builder: HealthKitAppBuilder;
  runner: HealthSimulatorRunner;
  sheet: HealthSheetUi;
  timer: Pick<Timer, "sleep">;
  /** Sheet polls before concluding it is not shown. Default 20. */
  sheetPolls?: number;
  sheetPollMs?: number;
}

const SEEDED_TYPES = [
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierHeartRate",
  "HKCategoryTypeIdentifierSleepAnalysis",
];
// HealthKit's "Authorization is not determined" error code.
const AUTH_NOT_DETERMINED = /Code=5\b/;

function seedArgs(request: HealthSeedRequest): string[] {
  return [
    `steps=${request.steps ?? 4242}`,
    `hr=${request.heartRate ?? 72}`,
    `sleepHours=${request.sleepHours ?? 8}`,
  ];
}

function validate(request: HealthSeedRequest): void {
  for (const [name, value] of Object.entries(request)) {
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
      throw new HealthSeedError("unsupported", `${name} must be a positive number`);
    }
  }
}

/** Seeds steps, heart rate and sleep into an iOS simulator's HealthKit store. */
export class HealthKitSeeder {
  private readonly sheetPolls: number;
  private readonly sheetPollMs: number;

  constructor(private readonly deps: HealthKitSeederOptions) {
    this.sheetPolls = deps.sheetPolls ?? 20;
    this.sheetPollMs = deps.sheetPollMs ?? 500;
  }

  async seed(udid: string, request: HealthSeedRequest = {}): Promise<HealthSeedResult> {
    validate(request);
    const { builder, runner } = this.deps;
    const appPath = await builder.build();
    await runner.install(udid, appPath);
    await runner.terminate(udid, HEALTHKIT_SEEDER_BUNDLE_ID);
    const run = await runner.launch(udid, HEALTHKIT_SEEDER_BUNDLE_ID, seedArgs(request));
    const outputPromise = run.waitForOutput();
    // Avoid an unhandled rejection if the sheet step throws first.
    outputPromise.catch(() => undefined);
    const sheetAccepted = await this.acceptSheet(udid);
    const report = parseHealthProbeOutput(await outputPromise);
    this.assertSeeded(report);
    const readBack: Record<string, number> = {};
    for (const type of SEEDED_TYPES) {
      readBack[type] = report.reads[type] ?? 0;
    }
    return { sheetAccepted, readBack };
  }

  private async acceptSheet(udid: string): Promise<boolean> {
    const { sheet, timer } = this.deps;
    for (let poll = 0; poll < this.sheetPolls; poll += 1) {
      const taps = planHealthSheetTaps(await sheet.elements(udid));
      if (taps.length > 0) {
        for (const text of taps) {
          await sheet.tapText(udid, text);
        }
        return true;
      }
      await timer.sleep(this.sheetPollMs);
    }
    return false;
  }

  private assertSeeded(report: HealthProbeReport): void {
    if (!report.available) {
      throw new HealthSeedError("unavailable", "HealthKit is not available on this device");
    }
    const denied =
      report.authorizationOk === false ||
      report.authorizationError !== null ||
      (report.saveError !== null && AUTH_NOT_DETERMINED.test(report.saveError)) ||
      Object.values(report.readErrors).some((e) => AUTH_NOT_DETERMINED.test(e));
    if (denied) {
      throw new HealthSeedError(
        "permission_denied",
        `Health Access was not granted (${report.authorizationError ?? report.saveError ?? "denied"})`,
      );
    }
    if (report.saveOk !== true) {
      throw new HealthSeedError(
        "permission_denied",
        `HealthKit save did not complete (${report.saveError ?? "no result; was the sheet accepted?"})`,
      );
    }
  }
}

/** Runs the seeder app through `xcrun simctl`, capturing stdout to a file the host polls. */
export class SimctlHealthSimulatorRunner implements HealthSimulatorRunner {
  constructor(
    private readonly exec: ExecFileAsync,
    private readonly timer: Pick<Timer, "sleep">,
    private readonly outputDir: string,
    private readonly timeoutPolls = 240,
    private readonly pollMs = 500,
  ) {}

  async install(udid: string, appPath: string): Promise<void> {
    await this.exec("xcrun", ["simctl", "install", udid, appPath]);
  }

  async terminate(udid: string, bundleId: string): Promise<void> {
    try {
      await this.exec("xcrun", ["simctl", "terminate", udid, bundleId]);
    } catch (error) {
      // Not running is the expected state before a fresh launch.
      logger.debug(`simctl terminate ${bundleId} skipped: ${errorMessage(error)}`);
    }
  }

  async launch(udid: string, bundleId: string, args: string[]): Promise<HealthAppRun> {
    const outputPath = join(this.outputDir, `hkseeder-${udid}.out`);
    await writeFile(outputPath, "");
    await this.exec("xcrun", [
      "simctl",
      "launch",
      `--stdout=${outputPath}`,
      udid,
      bundleId,
      ...args,
    ]);
    return {
      waitForOutput: async () => {
        for (let poll = 0; poll < this.timeoutPolls; poll += 1) {
          const text = await readFile(outputPath, "utf8");
          if (/^HKPROBE done$/m.test(text)) {
            return text;
          }
          await this.timer.sleep(this.pollMs);
        }
        throw new HealthSeedError(
          "permission_denied",
          "The seeding app did not finish; the Health Access sheet was probably not accepted",
        );
      },
    };
  }
}
