/**
 * Android device preflight and post-run screen capture for the agent benchmark.
 *
 * Preflight runs outside the measured window: it resolves the target serial,
 * optionally installs the APK, resets app data, and deep-links to the suite's
 * start screen so every run begins from the same state. The post-run screen dump
 * (`uiautomator dump`) is an independent oracle: it reads the device directly
 * rather than trusting the agent's own summary.
 */

import { parseStringPromise } from "xml2js";
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
 * Pick the device. Exactly one online device is required: nothing pins the MCP
 * server to a serial, so with several online the agent could act on a device the
 * harness is not preparing or verifying. `requested` only asserts which one it is.
 */
export async function resolveSerial(runner: CommandRunner, requested?: string): Promise<string> {
  const online = parseOnlineSerials(await adb(runner, ["devices"]));
  if (online.length !== 1) {
    throw new Error(
      online.length === 0
        ? "No online Android device. Boot an emulator first."
        : `Multiple online devices (${online.join(", ")}); the benchmark needs exactly one, ` +
            "because the agent could otherwise act on a different device than the one verified.",
    );
  }
  if (requested && online[0] !== requested) {
    throw new Error(`Device ${requested} is not the online device (${online[0]}).`);
  }
  return online[0];
}

export type PreferenceValue = boolean | number | string;

export interface PreflightSpec {
  serial: string;
  packageName: string;
  apkPath?: string;
  /** Hex SHA-256 of `apkPath`; identifies the build without the install timestamp. */
  apkDigest?: string;
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
 * With an APK digest, the digest replaces `lastUpdateTime`: preflight reinstalls the
 * APK every run, which changes the install time even for a byte-identical build.
 */
export function describeAppBuild(dumpsysOutput: string, apkDigest?: string): string {
  const field = (pattern: RegExp) => dumpsysOutput.match(pattern)?.[1]?.trim();
  const parts = [
    ["versionName", field(/versionName=(\S+)/)],
    ["versionCode", field(/versionCode=(\d+)/)],
    apkDigest
      ? ["sha256", apkDigest.slice(0, 16)]
      : ["lastUpdateTime", field(/lastUpdateTime=(.+)/)],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
  return parts.length > 0 ? parts.map(([key, value]) => `${key}=${value}`).join(" ") : "unknown";
}

/**
 * Confirm `app.packageName` is now the APK at `apkPath`: an APK for another package
 * installs fine and leaves a stale target app behind, which the run would then measure
 * under the new APK's digest. Android keeps the installed base APK byte-identical.
 */
async function verifyInstalledApk(
  runner: CommandRunner,
  spec: PreflightSpec,
  pmPath: string,
): Promise<string> {
  const basePath = pmPath
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^package:/, ""))
    .find((path) => path.endsWith("/base.apk"));
  // Fail closed: an unverified install could be a stale app recorded under this APK's digest.
  const unverifiable = (reason: string) =>
    new Error(
      `Cannot verify that ${spec.packageName} on ${spec.serial} is the APK at ${spec.apkPath} ` +
        `(${reason}). Install it yourself and remove app.apkPath to run without the check.`,
    );
  if (!basePath) {
    throw unverifiable("pm path listed no base.apk");
  }
  const result = await runner.run(
    "adb",
    ["-s", spec.serial, "shell", "sha256sum", shellQuote(basePath)],
    ADB_TIMEOUT_MS,
  );
  const deviceDigest = result.exitCode === 0 ? result.stdout.trim().split(/\s+/)[0] : undefined;
  if (!deviceDigest || !/^[0-9a-f]{64}$/.test(deviceDigest)) {
    const output = `${result.stderr}${result.stdout}`.trim().slice(0, 200);
    throw unverifiable(`sha256sum exited ${result.exitCode}: ${output}`);
  }
  if (deviceDigest !== spec.apkDigest) {
    throw new Error(
      `${spec.packageName} on ${spec.serial} is not the APK at ${spec.apkPath}; ` +
        "check that app.apkPath builds app.packageName.",
    );
  }
  return `verified ${spec.packageName} is ${spec.apkPath}`;
}

const DEVICE_PROPERTIES =
  "getprop ro.build.version.sdk; getprop ro.product.model; getprop persist.sys.locale; wm size; wm density";

/**
 * The device environment a run measured against (SDK level, model, locale, screen size,
 * density), since hierarchy shape, scrolling, and timing all depend on it. Best effort:
 * a device that cannot answer reports "unknown", which never matches a baseline.
 */
export async function describeDevice(runner: CommandRunner, serial: string): Promise<string> {
  const result = await runner.run(
    "adb",
    ["-s", serial, "shell", DEVICE_PROPERTIES],
    ADB_TIMEOUT_MS,
  );
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
  // `wm` prints the physical value and then any override; the override is what apps see.
  const lastValue = (label: string) =>
    lines
      .filter((line) => line.includes(`${label}:`))
      .map((line) => line.slice(line.indexOf(":") + 1).trim())
      .at(-1);
  const parts = [
    ["sdk", lines[0]],
    ["model", lines[1]],
    ["locale", lines[2]],
    ["size", lastValue("size")],
    ["density", lastValue("density")],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return result.exitCode === 0 && parts.length === 5
    ? parts.map(([key, value]) => `${key}=${value}`).join(" ")
    : "unknown";
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
  if (spec.apkPath && spec.apkDigest) {
    log.push(await verifyInstalledApk(runner, spec, installed));
  }
  const dumpsys = await adb(runner, [...target, "shell", "dumpsys", "package", spec.packageName]);
  const appBuild = describeAppBuild(dumpsys, spec.apkDigest);
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

interface HierarchyNode {
  $?: Record<string, string>;
  node?: HierarchyNode[];
}

function visibleText(nodes: HierarchyNode[], packageName: string): string[] {
  return nodes.flatMap((node) => {
    const attributes = node.$ ?? {};
    const own =
      attributes.package === packageName
        ? [attributes.text, attributes["content-desc"]].filter((value): value is string =>
            Boolean(value),
          )
        : [];
    return [...own, ...visibleText(node.node ?? [], packageName)];
  });
}

/**
 * The text and content descriptions of `packageName`'s nodes, one per line. Screen checks
 * match only these, so resource ids, class names, and other apps' windows (the status bar,
 * a launcher, a dialog from another package) can never satisfy them.
 */
export async function screenTextForApp(xml: string, packageName: string): Promise<string> {
  const parsed: { hierarchy?: HierarchyNode } = await parseStringPromise(xml, {
    explicitArray: true,
  });
  return visibleText(parsed.hierarchy?.node ?? [], packageName).join("\n");
}
