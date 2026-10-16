/**
 * Android device preflight and post-run screen capture for the agent benchmark.
 *
 * Preflight runs outside the measured window: it resolves the target serial,
 * optionally installs the APK, resets app data, and deep-links to the suite's
 * start screen so every run begins from the same state. The post-run screen dump
 * (`uiautomator dump`) is an independent oracle: it reads the device directly
 * rather than trusting the agent's own summary.
 */

import { amStartReportedFailure } from "../../src/features/action/LaunchApp";
import { shellQuote } from "../../src/utils/shellQuote";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<CommandResult>;
}

const ADB_TIMEOUT_MS = 60_000;
const SCREEN_DUMP_PATH = "/sdcard/agent-benchmark-ui.xml";
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INSTALL_TIMEOUT_MS = 300_000;

/** Parse `adb devices` output into serials that are fully online (`device` state). */
export function parseOnlineSerials(adbDevicesOutput: string): string[] {
  return adbDevicesOutput
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0]);
}

async function adb(runner: CommandRunner, args: string[], timeoutMs = ADB_TIMEOUT_MS) {
  const result = await runner.run("adb", args, timeoutMs);
  if (result.exitCode !== 0) {
    const output = `${result.stderr}${result.stdout}`.trim();
    throw new Error(`adb ${args.join(" ")} failed (exit ${result.exitCode}): ${output}`);
  }
  return result.stdout;
}

/**
 * Pick the device: an explicit serial must be online; otherwise exactly one
 * online device is required so the agent cannot end up on the wrong one.
 */
export async function resolveSerial(runner: CommandRunner, requested?: string): Promise<string> {
  const online = parseOnlineSerials(await adb(runner, ["devices"]));
  if (requested) {
    if (!online.includes(requested)) {
      throw new Error(
        `Device ${requested} is not online (online: ${online.join(", ") || "none"}).`,
      );
    }
    return requested;
  }
  if (online.length !== 1) {
    throw new Error(
      online.length === 0
        ? "No online Android device. Boot an emulator first."
        : `Multiple online devices (${online.join(", ")}); pass --device <serial>.`,
    );
  }
  return online[0];
}

export type PreferenceValue = boolean | number | string;

export interface PreflightSpec {
  serial: string;
  packageName: string;
  apkPath?: string;
  clearAppData: boolean;
  /** SharedPreferences files to seed (file name without `.xml` → key/value pairs). */
  sharedPreferences?: Record<string, Record<string, PreferenceValue>>;
  launchUri?: string;
  /** Write a local staging file and return its path (used to push preference files). */
  stageFile(name: string, content: string): string;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Render a SharedPreferences XML document in Android's on-disk format. */
export function sharedPreferencesXml(values: Record<string, PreferenceValue>): string {
  const entries = Object.entries(values).map(([key, value]) => {
    const name = escapeXml(key);
    if (typeof value === "boolean") {
      return `<boolean name="${name}" value="${value}" />`;
    }
    if (typeof value === "number") {
      // Android parses <int> as a 32-bit Integer; wider integral values need <long>.
      const tag = !Number.isInteger(value)
        ? "float"
        : value >= INT32_MIN && value <= INT32_MAX
          ? "int"
          : "long";
      return `<${tag} name="${name}" value="${value}" />`;
    }
    return `<string name="${name}">${escapeXml(value)}</string>`;
  });
  return `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>${entries.join("")}</map>\n`;
}

/**
 * Seed preference files through `run-as` (debuggable builds only): push to
 * /data/local/tmp, then copy into the app's private shared_prefs directory.
 */
async function seedSharedPreferences(
  runner: CommandRunner,
  spec: PreflightSpec,
): Promise<string[]> {
  const target = ["-s", spec.serial];
  const runAs = [...target, "shell", "run-as", spec.packageName];
  const files = Object.entries(spec.sharedPreferences ?? {});
  if (files.length > 0) {
    await adb(runner, [...runAs, "mkdir", "-p", "shared_prefs"]);
  }
  const log: string[] = [];
  for (const [file, values] of files) {
    const local = spec.stageFile(`${file}.xml`, sharedPreferencesXml(values));
    const remote = `/data/local/tmp/agent-benchmark-${file}.xml`;
    await adb(runner, [...target, "push", local, remote]);
    await adb(runner, [...runAs, "cp", remote, `shared_prefs/${file}.xml`]);
    await adb(runner, [...target, "shell", "rm", "-f", remote]);
    log.push(`seeded shared_prefs/${file}.xml (${Object.keys(values).join(", ")})`);
  }
  return log;
}

/**
 * `am start` can print "Error: Activity not started…" and still exit 0 (older
 * Android releases), which would start a paid run on the wrong screen; reuse
 * LaunchApp's failure detection on both streams.
 */
async function launchDeepLink(
  runner: CommandRunner,
  serial: string,
  packageName: string,
  uri: string,
): Promise<void> {
  const args = ["-s", serial, "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW"];
  // `adb shell` joins its arguments into one device-shell command line, so quote the
  // URI (as OpenURL does): `&`, `$`, or spaces would otherwise split or expand it.
  const result = await runner.run(
    "adb",
    [...args, "-d", shellQuote(uri), packageName],
    ADB_TIMEOUT_MS,
  );
  if (result.exitCode !== 0 || amStartReportedFailure(result.stdout, result.stderr)) {
    const output = `${result.stderr}${result.stdout}`.trim();
    throw new Error(`Deep link ${uri} did not start (exit ${result.exitCode}): ${output}`);
  }
}

/**
 * The installed build's fingerprint from `dumpsys package` (same fields as
 * GetAppMetadata), so results from different builds are never mistaken as comparable.
 */
export function describeAppBuild(dumpsysOutput: string): string {
  const field = (pattern: RegExp) => dumpsysOutput.match(pattern)?.[1]?.trim();
  const parts = [
    ["versionName", field(/versionName=(\S+)/)],
    ["versionCode", field(/versionCode=(\d+)/)],
    ["lastUpdateTime", field(/lastUpdateTime=(.+)/)],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
  return parts.length > 0 ? parts.map(([key, value]) => `${key}=${value}`).join(" ") : "unknown";
}

export interface PreflightOutcome {
  /** What was done, one line per step. */
  log: string[];
  /** Fingerprint of the installed app build (see describeAppBuild). */
  appBuild: string;
}

/** Run preflight steps; returns the step log and the installed app build. */
export async function runPreflight(
  runner: CommandRunner,
  spec: PreflightSpec,
): Promise<PreflightOutcome> {
  const log: string[] = [];
  const target = ["-s", spec.serial];
  if (spec.apkPath) {
    await adb(runner, [...target, "install", "-r", "-t", spec.apkPath], INSTALL_TIMEOUT_MS);
    log.push(`installed ${spec.apkPath}`);
  }
  const installed = await adb(runner, [...target, "shell", "pm", "path", spec.packageName]);
  if (!installed.includes("package:")) {
    throw new Error(`${spec.packageName} is not installed on ${spec.serial}; set app.apkPath.`);
  }
  const dumpsys = await adb(runner, [...target, "shell", "dumpsys", "package", spec.packageName]);
  const appBuild = describeAppBuild(dumpsys);
  log.push(`app build: ${appBuild}`);
  await adb(runner, [...target, "shell", "am", "force-stop", spec.packageName]);
  log.push(`force-stopped ${spec.packageName}`);
  if (spec.clearAppData) {
    // `pm clear` can print "Failed" and still exit 0; require the "Success" line
    // (as ClearAppData does) so a run never starts from the previous run's state.
    const cleared = await adb(runner, [...target, "shell", "pm", "clear", spec.packageName]);
    if (!cleared.split(/\r?\n/).some((line) => line.trim() === "Success")) {
      throw new Error(
        `pm clear ${spec.packageName} did not succeed: ${cleared.trim() || "no output"}`,
      );
    }
    log.push(`cleared app data for ${spec.packageName}`);
  }
  log.push(...(await seedSharedPreferences(runner, spec)));
  if (spec.launchUri) {
    await launchDeepLink(runner, spec.serial, spec.packageName, spec.launchUri);
    log.push(`launched ${spec.launchUri}`);
  }
  return { log, appBuild };
}

/**
 * Dump the current UI hierarchy XML to a device file and read it back. Dumping to
 * `/dev/tty` frequently yields only the "UI hierarchy dumped to" status line
 * instead of the XML (see TalkBackToggle.dumpWindowHierarchy, #3921).
 */
export async function captureScreen(runner: CommandRunner, serial: string): Promise<string> {
  const target = ["-s", serial];
  try {
    await adb(runner, [...target, "shell", "uiautomator", "dump", SCREEN_DUMP_PATH]);
    const xml = await adb(runner, [...target, "exec-out", "cat", SCREEN_DUMP_PATH]);
    if (!xml.includes("<hierarchy")) {
      throw new Error(`uiautomator dump returned no hierarchy: ${xml.slice(0, 200)}`);
    }
    return xml;
  } finally {
    try {
      await runner.run("adb", [...target, "shell", "rm", "-f", SCREEN_DUMP_PATH], ADB_TIMEOUT_MS);
    } catch {
      // Best effort: a leftover dump file is harmless and overwritten by the next run.
    }
  }
}

/** Decode the five predefined XML entities so screen checks match visible text. */
export function decodeXmlEntities(xml: string): string {
  return xml
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
