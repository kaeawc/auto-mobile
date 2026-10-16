/**
 * Android device preflight and post-run screen capture for the agent benchmark.
 *
 * Preflight runs outside the measured window: it resolves the target serial,
 * optionally installs the APK, resets app data, and deep-links to the suite's
 * start screen so every run begins from the same state. The post-run screen dump
 * (`uiautomator dump`) is an independent oracle: it reads the device directly
 * rather than trusting the agent's own summary.
 */

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
      const tag = Number.isInteger(value) ? "int" : "float";
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

/** Run preflight steps and return a log of what was done, one line per step. */
export async function runPreflight(runner: CommandRunner, spec: PreflightSpec): Promise<string[]> {
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
  await adb(runner, [...target, "shell", "am", "force-stop", spec.packageName]);
  log.push(`force-stopped ${spec.packageName}`);
  if (spec.clearAppData) {
    await adb(runner, [...target, "shell", "pm", "clear", spec.packageName]);
    log.push(`cleared app data for ${spec.packageName}`);
  }
  log.push(...(await seedSharedPreferences(runner, spec)));
  if (spec.launchUri) {
    await adb(runner, [
      ...target,
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      spec.launchUri,
      spec.packageName,
    ]);
    log.push(`launched ${spec.launchUri}`);
  }
  return log;
}

/** Dump the current UI hierarchy XML straight from the device. */
export async function captureScreen(runner: CommandRunner, serial: string): Promise<string> {
  const xml = await adb(runner, ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"]);
  if (!xml.includes("<hierarchy")) {
    throw new Error(`uiautomator dump returned no hierarchy: ${xml.slice(0, 200)}`);
  }
  return xml;
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
