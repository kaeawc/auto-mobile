import { Mutex } from "async-mutex";
import { HealthSeedError } from "./healthSeedError";
import type { Timer } from "../SystemTimer";
import { HEALTHKIT_SEEDER_BUNDLE_ID, type HealthKitAppBuilder } from "./healthKitSeederApp";

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

type ReportHandler = (report: HealthProbeReport, match: RegExpExecArray) => void;

const HANDLERS: Array<[RegExp, ReportHandler]> = [
  [
    /^available=(true|false)/,
    (r, m) => {
      r.available = m[1] === "true";
    },
  ],
  [
    /^requestAuthorization ok=(true|false) err=(.*)$/,
    (r, m) => {
      r.authorizationOk = m[1] === "true";
      r.authorizationError = errorText(m[2]);
    },
  ],
  [
    /^save ok=(true|false) err=(.*)$/,
    (r, m) => {
      r.saveOk = m[1] === "true";
      r.saveError = errorText(m[2]);
    },
  ],
  [
    /^read (\S+) n=(-?\d+) err=(.*)$/,
    (r, m) => {
      r.reads[m[1]] = Number(m[2]);
      const err = errorText(m[3]);
      if (err) {
        r.readErrors[m[1]] = err;
      }
    },
  ],
  [
    /^done$/,
    (r) => {
      r.done = true;
    },
  ],
];

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
    const body = LINE.exec(raw)?.[1] ?? "";
    for (const [pattern, handle] of HANDLERS) {
      const match = pattern.exec(body);
      if (match) {
        handle(report, match);
        break;
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

// One seed per simulator at a time: a seed terminates the app and truncates the
// per-UDID output file, so overlapping seeds would kill or read each other's run.
const deviceLocks = new Map<string, Mutex>();

function withDeviceLock<T>(udid: string, action: () => Promise<T>): Promise<T> {
  let lock = deviceLocks.get(udid);
  if (!lock) {
    lock = new Mutex();
    deviceLocks.set(udid, lock);
  }
  return lock.runExclusive(action);
}

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
    const build = await this.deps.builder.build();
    return withDeviceLock(udid, async () => {
      try {
        await this.deps.runner.install(udid, build.appPath);
      } finally {
        await build.dispose();
      }
      return this.runSeeder(udid, request);
    });
  }

  private async runSeeder(udid: string, request: HealthSeedRequest): Promise<HealthSeedResult> {
    const { runner } = this.deps;
    await runner.terminate(udid, HEALTHKIT_SEEDER_BUNDLE_ID);
    const run = await runner.launch(udid, HEALTHKIT_SEEDER_BUNDLE_ID, seedArgs(request));
    const outputPromise = run.waitForOutput();
    // Settles either way so the sheet step can stop polling; this also keeps a
    // rejection that lands while the sheet step runs from going unhandled.
    const finished = outputPromise.then(
      () => undefined,
      () => undefined,
    );
    const sheetAccepted = await this.acceptSheet(udid, finished);
    const report = parseHealthProbeOutput(await outputPromise);
    this.assertSeeded(report);
    return { sheetAccepted, readBack: verifiedReadBack(report) };
  }

  /**
   * Taps through the Health Access sheet. An app that finishes without showing it
   * (already authorized) ends polling at the next poll instead of after all of them.
   */
  private async acceptSheet(udid: string, finished: Promise<void>): Promise<boolean> {
    const { sheet, timer } = this.deps;
    let appFinished = false;
    void finished.then(() => {
      appFinished = true;
    });
    for (let poll = 0; poll < this.sheetPolls && !appFinished; poll += 1) {
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

/** Every seeded type must read back without error and with a nonnegative count. */
function verifiedReadBack(report: HealthProbeReport): Record<string, number> {
  const readBack: Record<string, number> = {};
  for (const type of SEEDED_TYPES) {
    const count = report.reads[type];
    const readError = report.readErrors[type];
    if (count === undefined || count < 0 || readError !== undefined) {
      throw new HealthSeedError(
        "verification_failed",
        `HealthKit saved the samples but reading back ${type} failed (${
          readError ?? (count === undefined ? "no read reported" : `count ${count}`)
        })`,
      );
    }
    readBack[type] = count;
  }
  return readBack;
}
