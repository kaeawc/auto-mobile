import type { AdbReverseCommands } from "../../utils/android-cmdline-tools/adbReverse";
import { rethrowDeviceTransportUnavailable } from "../../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import type { DeviceListenerTable } from "../../utils/android-cmdline-tools/deviceTcpListeners";
import { DeviceLostError } from "../../models/DeviceLostError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { PortReverseError } from "./PortReverseError";

/**
 * What listens on a device port. `none`: nothing. `reverse`: adbd, for the reverse `--list`
 * shows there. `process`: some other process, by uid (and package when exactly one has it).
 * `unsupported`: the device's listener table could not be read.
 */
export type DeviceListener =
  | { kind: "none" }
  | { kind: "reverse" }
  | { kind: "process"; uid: number; package?: string }
  | { kind: "unsupported"; detail: string };

type Adb = Pick<AdbReverseCommands, "listeners" | "packageForUid">;

/** A lost device or transport is the call's failure, never a diagnostic that reads as "unknown". */
function rethrowDeviceLoss(error: unknown): void {
  if (error instanceof DeviceLostError) {
    throw error;
  }
  rethrowDeviceTransportUnavailable(error);
}

async function readTable(adb: Adb, deviceId: string): Promise<DeviceListenerTable> {
  try {
    return await adb.listeners();
  } catch (error) {
    rethrowDeviceLoss(error);
    logger.warn(
      `[portReverse] reading device listeners on ${deviceId} failed: ${errorMessage(error)}`,
    );
    return { kind: "unsupported", detail: errorMessage(error) };
  }
}

async function lookupPackage(adb: Adb, uid: number, deviceId: string) {
  try {
    return await adb.packageForUid(uid);
  } catch (error) {
    rethrowDeviceLoss(error);
    logger.warn(
      `[portReverse] package lookup for uid ${uid} on ${deviceId} failed: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

/** The device listener on each port, from one table read; `reversed` holds `--list`'s ports. */
export async function deviceListeners(
  adb: Adb,
  deviceId: string,
  ports: readonly number[],
  reversed: ReadonlySet<number>,
): Promise<Map<number, DeviceListener>> {
  const result = new Map<number, DeviceListener>();
  if (ports.length === 0) {
    return result;
  }
  const table = await readTable(adb, deviceId);
  const packages = new Map<number, Promise<string | undefined>>();
  for (const port of ports) {
    const uid = table.kind === "ok" ? table.listeners.get(port)?.[0] : undefined;
    if (table.kind === "unsupported") {
      result.set(port, { kind: "unsupported", detail: table.detail });
    } else if (uid === undefined) {
      result.set(port, { kind: "none" });
    } else if (reversed.has(port)) {
      result.set(port, { kind: "reverse" });
    } else {
      const lookup = packages.get(uid) ?? lookupPackage(adb, uid, deviceId);
      packages.set(uid, lookup);
      const name = await lookup;
      result.set(port, { kind: "process", uid, ...(name === undefined ? {} : { package: name }) });
    }
  }
  return result;
}

/**
 * After an add failed and `--list` shows no reverse there: throws `port_reverse_device_port_in_use`
 * when a device process listens on the port. Returns quietly when it cannot tell.
 */
export async function throwIfDevicePortHeld(
  adb: Adb,
  deviceId: string,
  devicePort: number,
): Promise<void> {
  const listener = (await deviceListeners(adb, deviceId, [devicePort], new Set())).get(devicePort);
  if (listener?.kind !== "process") {
    return;
  }
  const holder =
    listener.package === undefined
      ? `uid ${listener.uid}`
      : `${listener.package} (uid ${listener.uid})`;
  throw new PortReverseError(
    "port_reverse_device_port_in_use",
    `tcp:${devicePort} on ${deviceId} is already listened on by ${holder}, so adb cannot bind the ` +
      "reverse there. Stop that listener or choose another device port.",
    [devicePort],
  );
}
