#!/usr/bin/env bun
/**
 * Build :killprofile-fixture:assembleDebug separately, then on a disposable rootable AVD:
 * bun scripts/kill-profile-survival/run.ts --serial emulator-5556 --avd Survival --out scratch/survival.json
 * Each profile takes 19 minutes: RTC advancement cannot advance elapsed-time Android schedulers.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs, promisify } from "node:util";
import { AndroidDeviceClockAdapter } from "../../src/features/utility/AndroidDeviceClockAdapter";
import { parseCommandArgs } from "../../src/utils/android-cmdline-tools/AdbCommandArguments";
import type {
  AdbCommandRunner,
  AdbExecuteOptions,
} from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { createExecResult } from "../../src/utils/execResult";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { runHarness } from "./harness";

export interface AdbProcess {
  run(args: string[], options?: AdbExecuteOptions): Promise<{ stdout: string; stderr: string }>;
}

export function validateTarget(serial: string, avd: string): void {
  if (
    !/^emulator-\d+$/.test(serial) ||
    serial === "emulator-5554" ||
    !avd.trim() ||
    /iphone/i.test(`${serial} ${avd}`)
  ) {
    throw new Error(
      "Use an explicit Android emulator serial other than emulator-5554 and a non-iPhone --avd",
    );
  }
}

/** Every operation, including restore/root/install, rechecks AVD identity before its command. */
export class AvdGuardedAdb implements AdbCommandRunner {
  constructor(
    private readonly serial: string,
    private readonly avd: string,
    private readonly process: AdbProcess,
  ) {
    validateTarget(serial, avd);
  }

  async executeCommand(command: string, options?: AdbExecuteOptions) {
    const identity = await this.process.run(["-s", this.serial, "emu", "avd", "name"], options);
    const name = identity.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim());
    if (identity.stderr.trim() || name.length !== 2 || name[0] !== this.avd || name[1] !== "OK") {
      throw new Error(`AVD identity mismatch on ${this.serial}; expected ${this.avd}`);
    }
    const result = await this.process.run(
      ["-s", this.serial, ...parseCommandArgs(command)],
      options,
    );
    return createExecResult(result.stdout, result.stderr);
  }
}

export function parseCli(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      serial: { type: "string" },
      avd: { type: "string" },
      apk: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.serial || !values.avd || !values.out) {
    throw new Error("--serial, --avd and --out scratch/<file>.json are required");
  }
  validateTarget(values.serial, values.avd);
  const out = resolve(values.out);
  const underScratch = relative(resolve("scratch"), out);
  if (
    !underScratch ||
    underScratch === ".." ||
    underScratch.startsWith(`..${sep}`) ||
    isAbsolute(underScratch)
  ) {
    throw new Error("--out must name a file under this checkout's scratch/");
  }
  return {
    serial: values.serial,
    avd: values.avd,
    apk: resolve(
      values.apk ??
        "android/killprofile-fixture/build/outputs/apk/debug/killprofile-fixture-debug.apk",
    ),
    out,
  };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const execute = promisify(execFile);
  const shell = new AvdGuardedAdb(options.serial, options.avd, {
    run: (args, settings) =>
      execute("adb", args, {
        encoding: "utf8",
        timeout: settings?.timeoutMs ?? 60_000,
        signal: settings?.signal,
        maxBuffer: 4 * 1024 * 1024,
      }),
  });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error("Survival run interrupted; restoring device"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await runHarness(options, {
      shell,
      clock: new AndroidDeviceClockAdapter(shell),
      timer: defaultTimer,
      signal: cancellation.signal,
    });
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Survival report: ${options.out}`);
    process.exitCode =
      report.aborted || report.results.some((result) => result.mismatches.length) ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(`kill-profile-survival: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
