import { join } from "node:path";
import { z } from "zod";
import type { PrivateDaemonCliDeps } from "./private-daemon";
import type { PrivateDaemonSpec } from "./privateDaemonEnv";
import { errorMessage } from "../../src/utils/describeUnknownError";

export const DAEMON_DEVICES_METHOD = "daemon/availableDevices";
const TIMEOUT_MS = 2000;
const pidSchema = z.object({ pid: z.number().int().positive() });
function plainPid(spec: PrivateDaemonSpec, deps: PrivateDaemonCliDeps): number | undefined {
  if (!deps.exists(spec.plainPidFilePath)) {
    return undefined;
  }
  const pid = Number(deps.readFile(spec.plainPidFilePath).trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
export async function privateDaemonStatus(
  spec: PrivateDaemonSpec,
  deps: PrivateDaemonCliDeps,
): Promise<Record<string, unknown>> {
  let pid: number | undefined;
  let txt: number | undefined;
  let hasTxt = false;
  let alive = false;
  let pidReason: string | undefined;
  try {
    const hasJson = deps.exists(spec.pidFilePath);
    if (hasJson) {
      pid = pidSchema.parse(JSON.parse(deps.readFile(spec.pidFilePath))).pid;
    }
    hasTxt = deps.exists(spec.plainPidFilePath);
    txt = plainPid(spec, deps);
    if (!hasJson) {
      pid = txt;
    }
    alive = pid !== undefined && deps.isPidAlive(pid);
  } catch (error) {
    // Malformed/unreadable pid evidence must not prevent the remaining diagnostic sections.
    pidReason = errorMessage(error);
  }
  const socket = await diagnostic(
    async () => deps.probeSocket(spec.socketPath),
    (error) => ({ alive: false, reason: error }),
  );
  return {
    name: spec.name,
    ...(pidReason ? { pidReason } : {}),
    port: spec.port,
    pid,
    alive,
    socket: spec.socketPath,
    envFile: join(spec.dir, "env.sh"),
    pidTxt: !hasTxt ? "missing" : txt !== undefined && txt === pid && alive ? "ok" : "stale",
    socketAlive: socket.alive,
    ...(!socket.alive ? { socketReason: socket.reason } : {}),
  };
}
async function diagnostic<T>(run: () => Promise<T>, failure: (reason: string) => T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Status is best-effort: preserve a typed failure and continue other sections.
    return failure(errorMessage(error));
  }
}
type DeviceSection = unknown[] | { skipped: string } | { error: string };
async function androidDevices(deps: PrivateDaemonCliDeps): Promise<DeviceSection> {
  const port = Number(deps.env.ANDROID_ADB_SERVER_PORT ?? 5037);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { skipped: "invalid ANDROID_ADB_SERVER_PORT" };
  }
  if (!(await deps.isTcpPortListening("127.0.0.1", port, TIMEOUT_MS))) {
    return { skipped: "no adb server listening" };
  }
  // Force the checked local endpoint, even if inherited ADB_SERVER_SOCKET points elsewhere.
  const env = {
    ...deps.env,
    ADB_SERVER_SOCKET: `tcp:127.0.0.1:${port}`,
    ANDROID_ADB_SERVER_PORT: String(port),
  };
  const result = await deps.runCapture("adb", ["devices", "-l"], definedEnv(env), TIMEOUT_MS);
  if (result.exitCode !== 0) {
    return { skipped: result.stderr || `adb exited ${result.exitCode}` };
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("List of devices") && !line.startsWith("*"))
    .map((line) => {
      const [deviceId, state, ...details] = line.trim().split(/\s+/);
      return { deviceId, state, details };
    });
}
function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
const simctlSchema = z.object({
  devices: z.record(
    z.array(z.object({ udid: z.string(), name: z.string(), state: z.string() }).passthrough()),
  ),
});
async function iosDevices(deps: PrivateDaemonCliDeps): Promise<DeviceSection> {
  const result = await deps.runCapture(
    "xcrun",
    ["simctl", "list", "devices", "booted", "--json"],
    definedEnv(deps.env),
    TIMEOUT_MS,
  );
  if (result.exitCode !== 0) {
    return { skipped: result.stderr || `simctl exited ${result.exitCode}` };
  }
  return Object.values(simctlSchema.parse(JSON.parse(result.stdout)).devices).flat();
}
const daemonDevicesSchema = z.object({ devices: z.array(z.unknown()) });
async function daemonDevices(
  spec: PrivateDaemonSpec,
  deps: PrivateDaemonCliDeps,
): Promise<DeviceSection> {
  const probe = await deps.probeSocket(spec.socketPath);
  if (!probe.alive) {
    return { error: probe.reason };
  }
  // No strictly snapshot-only inventory frame exists. availableDevices refreshes ownership and
  // discovery, but unlike refreshDevices does not add/boot/claim devices (daemonRequestHandlers.ts).
  const result = await deps.probeSocket(spec.socketPath, {
    method: DAEMON_DEVICES_METHOD,
    timeoutMs: TIMEOUT_MS,
  });
  if (!result.alive) {
    return { error: result.reason };
  }
  const parsed = daemonDevicesSchema.safeParse(result.result);
  return parsed.success
    ? parsed.data.devices
    : { error: "daemon/availableDevices refused or returned no device list" };
}
export async function privateDaemonDeviceStatus(
  specs: PrivateDaemonSpec[],
  deps: PrivateDaemonCliDeps,
): Promise<Record<string, unknown>> {
  const android = await diagnostic<DeviceSection>(
    () => androidDevices(deps),
    (skipped) => ({ skipped }),
  );
  const ios = await diagnostic<DeviceSection>(
    () => iosDevices(deps),
    (skipped) => ({ skipped }),
  );
  const devices: Record<string, DeviceSection> = {};
  for (const spec of specs) {
    devices[spec.name] = await diagnostic<DeviceSection>(
      () => daemonDevices(spec, deps),
      (error) => ({ error }),
    );
  }
  return {
    daemonDevicesMethod: DAEMON_DEVICES_METHOD,
    hostDevices: { android, ios },
    daemonDevices: devices,
  };
}
