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

/** The `health.read` sample types the disposable app can query (#14215). */
export const HEALTH_READ_TYPES = {
  steps: { identifier: "HKQuantityTypeIdentifierStepCount", unit: "count" },
  heartRate: { identifier: "HKQuantityTypeIdentifierHeartRate", unit: "count/min" },
  sleep: { identifier: "HKCategoryTypeIdentifierSleepAnalysis", unit: "sleepAnalysis" },
} as const;

export type HealthSampleType = keyof typeof HEALTH_READ_TYPES;

export interface HealthReadRequest {
  /** One of {@link HEALTH_READ_TYPES}; any other value is `unsupported`. */
  type: string;
  /** Epoch milliseconds; samples overlapping `[start, end]` are returned. */
  range: { start: number; end: number };
}

export interface HealthSample {
  /** Epoch milliseconds. */
  start: number;
  end: number;
  /** Quantity in `unit`, or the `HKCategoryValueSleepAnalysis` raw value for sleep. */
  value: number;
  unit: string;
}

export interface HealthReadResult {
  type: HealthSampleType;
  samples: HealthSample[];
  /** Whether the Health Access sheet was shown and accepted (false when already authorized). */
  sheetAccepted: boolean;
}

export interface HealthProbeSample {
  identifier: string;
  /** Epoch seconds, as the app prints them. */
  start: number;
  end: number;
  value: number;
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
  /** Samples printed by a `read=` launch. */
  samples: HealthProbeSample[];
  /** The request the app refused (`unsupported ...` line), if any. */
  unsupported: string | null;
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
    /^sample (\S+) start=(\S+) end=(\S+) value=(\S+)$/,
    (r, m) => {
      r.samples.push({
        identifier: m[1],
        start: Number(m[2]),
        end: Number(m[3]),
        value: Number(m[4]),
      });
    },
  ],
  [
    /^unsupported (.*)$/,
    (r, m) => {
      r.unsupported = m[1];
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
    samples: [],
    unsupported: null,
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

/** A `tapOn` selector for one Health Access sheet control. */
export type HealthSheetTap = { elementId: string } | { text: string };

/** "Turn On All" by its label: the measured id is shared with "Turn Off All". */
export const TURN_ON_ALL_TAP: HealthSheetTap = { text: "Turn On All" };
/** "Allow" by its measured id, so the tap does not depend on the sheet's language. */
export const ALLOW_TAP: HealthSheetTap = { elementId: HEALTH_SHEET_IDS.allow };

/** Which taps the Health Access sheet currently needs; empty when it is not shown. */
export function planHealthSheetTaps(elements: readonly SheetElement[]): HealthSheetTap[] {
  const all = elements.find((e) => e.elementId === HEALTH_SHEET_IDS.allCategory);
  const allow = elements.some((e) => e.elementId === HEALTH_SHEET_IDS.allow);
  if (!all && !allow) {
    return [];
  }
  // The Allow button is off screen until "Turn On All" is tapped. The category button
  // reads "Turn Off All" once everything is on: tapping it would revoke access, which is
  // also why it is tapped by label and never by its shared id.
  return all?.label === "Turn On All" ? [TURN_ON_ALL_TAP, ALLOW_TAP] : [ALLOW_TAP];
}

/** Reads the simulator UI and taps with `tapOn` selectors, in-simulator only. */
export interface HealthSheetUi {
  elements(udid: string): Promise<SheetElement[]>;
  tap(udid: string, selector: HealthSheetTap): Promise<void>;
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

const SEEDED_TYPES = Object.values(HEALTH_READ_TYPES).map((t) => t.identifier);
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

function isHealthSampleType(type: string): type is HealthSampleType {
  return Object.hasOwn(HEALTH_READ_TYPES, type);
}

function readArgs(request: HealthReadRequest): string[] {
  if (!isHealthSampleType(request.type)) {
    throw new HealthSeedError(
      "unsupported",
      `health.read type "${request.type}" is not supported (supported: ${Object.keys(HEALTH_READ_TYPES).join(", ")})`,
    );
  }
  const { start, end } = request.range;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new HealthSeedError("unsupported", "health.read range needs finite start <= end");
  }
  return [`read=${request.type}`, `from=${start / 1000}`, `to=${end / 1000}`];
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
    const { sheetAccepted, report } = await this.installAndRun(udid, seedArgs(request));
    this.assertSeeded(report);
    return { sheetAccepted, readBack: verifiedReadBack(report) };
  }

  /** `health.read`: the samples of one type overlapping the range, oldest first. */
  async read(udid: string, request: HealthReadRequest): Promise<HealthReadResult> {
    const args = readArgs(request);
    const type = request.type as HealthSampleType;
    const { sheetAccepted, report } = await this.installAndRun(udid, args);
    return { type, sheetAccepted, samples: readSamples(type, report) };
  }

  private async installAndRun(
    udid: string,
    args: string[],
  ): Promise<{ sheetAccepted: boolean; report: HealthProbeReport }> {
    const build = await this.deps.builder.build();
    return withDeviceLock(udid, async () => {
      try {
        await this.deps.runner.install(udid, build.appPath);
      } finally {
        await build.dispose();
      }
      return this.runApp(udid, args);
    });
  }

  private async runApp(
    udid: string,
    args: string[],
  ): Promise<{ sheetAccepted: boolean; report: HealthProbeReport }> {
    const { runner } = this.deps;
    await runner.terminate(udid, HEALTHKIT_SEEDER_BUNDLE_ID);
    const run = await runner.launch(udid, HEALTHKIT_SEEDER_BUNDLE_ID, args);
    const outputPromise = run.waitForOutput();
    // Settles either way so the sheet step can stop polling; this also keeps a
    // rejection that lands while the sheet step runs from going unhandled.
    const finished = outputPromise.then(
      () => undefined,
      () => undefined,
    );
    const sheetAccepted = await this.acceptSheet(udid, finished);
    return { sheetAccepted, report: parseHealthProbeOutput(await outputPromise) };
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
        for (const selector of taps) {
          await sheet.tap(udid, selector);
        }
        return true;
      }
      await timer.sleep(this.sheetPollMs);
    }
    return false;
  }

  private assertSeeded(report: HealthProbeReport): void {
    assertAuthorized(report);
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

/** `unavailable` and `permission_denied` checks shared by seeding and reading. */
function assertAuthorized(report: HealthProbeReport): void {
  if (!report.available) {
    throw new HealthSeedError("unavailable", "HealthKit is not available on this device");
  }
  const denied =
    report.authorizationOk === false ||
    report.authorizationError !== null ||
    (report.saveError !== null && AUTH_NOT_DETERMINED.test(report.saveError)) ||
    Object.values(report.readErrors).some((e) => AUTH_NOT_DETERMINED.test(e));
  if (denied) {
    const reason =
      report.authorizationError ??
      report.saveError ??
      Object.values(report.readErrors)[0] ??
      "denied";
    throw new HealthSeedError("permission_denied", `Health Access was not granted (${reason})`);
  }
}

/** The app's printed samples for `type`, in epoch milliseconds. */
function readSamples(type: HealthSampleType, report: HealthProbeReport): HealthSample[] {
  if (report.unsupported !== null) {
    throw new HealthSeedError("unsupported", `The HealthKit app refused ${report.unsupported}`);
  }
  assertAuthorized(report);
  const { identifier, unit } = HEALTH_READ_TYPES[type];
  const count = report.reads[identifier];
  const readError = report.readErrors[identifier];
  if (count === undefined || count < 0 || readError !== undefined) {
    throw new HealthSeedError(
      "read_failed",
      `Reading ${identifier} failed (${readError ?? (count === undefined ? "no read reported" : `count ${count}`)})`,
    );
  }
  const samples = report.samples
    .filter((sample) => sample.identifier === identifier)
    .map((sample) => ({
      start: Math.round(sample.start * 1000),
      end: Math.round(sample.end * 1000),
      value: sample.value,
      unit,
    }));
  if (samples.length !== count) {
    throw new HealthSeedError(
      "read_failed",
      `Reading ${identifier} reported ${count} samples but printed ${samples.length}`,
    );
  }
  return samples;
}
