// Pure harness evidence rules; importing deviceTools would register product tools and its logger.
import { isSessionBrokerDeviceName } from "../../src/daemon/sessionBroker/deviceNaming";
export interface DeviceIdentity {
  deviceId: string;
  name: string;
  platform: "android" | "ios";
  identity?: { stableId: string };
  processAvdName?: string;
}
export interface ProcessEvidence {
  batchMarker: boolean;
  daemonIndex?: number;
  processAvdName?: string;
}
export type DeviceProvenance =
  | "broker-owned"
  | "batch-booted"
  | "foreign"
  | "preexisting"
  | "batch-inferred"
  | "unknown";
interface Baseline {
  android: string[] | { unavailable: string };
  ios: string[] | { unavailable: string };
}
function carriesBatchMarker(text: string, batchDir: string): boolean {
  // Match the literal full value; whitespace inside a path is not its environment-value boundary.
  const marker = `MT_BATCH=${batchDir}`;
  let offset = text.indexOf(marker);
  while (offset !== -1) {
    const before = offset === 0 || /\s/.test(text[offset - 1]);
    const end = offset + marker.length;
    // ps eww appends whitespace-separated NAME=value entries, without quoting spaces in values.
    if (before && /^(?:\s+[A-Za-z_][A-Za-z_0-9]*=|\s*$)/.test(text.slice(end))) {
      return true;
    }
    offset = text.indexOf(marker, offset + marker.length);
  }
  return false;
}
export function parseProcessEvidence(text: string, batchDir: string): ProcessEvidence {
  const daemon = /(?:^|\s)MT_DAEMON=P(\d+)(?=\s|$)/.exec(text);
  const daemonIndex = daemon ? Number(daemon[1]) : undefined;
  // Android AVD names are single argv tokens. ps prints command followed by environment.
  const processAvdName = /(?:^|\s)-avd\s+(\S+)/.exec(text)?.[1];
  return {
    batchMarker: carriesBatchMarker(text, batchDir),
    ...(daemonIndex !== undefined && Number.isSafeInteger(daemonIndex) ? { daemonIndex } : {}),
    ...(processAvdName ? { processAvdName } : {}),
  };
}
export function matchesProtection(device: DeviceIdentity, protectedDevices: string[]): boolean {
  return [device.deviceId, device.name, device.identity?.stableId, device.processAvdName].some(
    (value) => value !== undefined && protectedDevices.includes(value),
  );
}
export function nameEvidenceMissing(device: DeviceIdentity): boolean {
  // Mirror isUnknownAndroidRuntimeName in src/server/deviceTools.ts without importing its logger.
  return (
    (!device.name.trim() ||
      (device.platform === "android" && device.name === `Unknown (${device.deviceId})`)) &&
    !device.processAvdName
  );
}
export function classifyDevice(
  device: DeviceIdentity,
  baseline: Baseline | undefined,
  protectedDevices: string[],
  evidence?: ProcessEvidence,
): { provenance: DeviceProvenance; protected: boolean; bootedBy?: string } {
  const inventory = baseline?.[device.platform];
  // Naming is display evidence only; broker-owned devices never gain shutdown authorization.
  const provenance = isSessionBrokerDeviceName(device.name)
    ? "broker-owned"
    : evidence
      ? evidence.batchMarker
        ? "batch-booted"
        : "foreign"
      : Array.isArray(inventory)
        ? inventory.includes(device.deviceId)
          ? "preexisting"
          : "batch-inferred"
        : "unknown";
  return {
    provenance,
    protected: matchesProtection(device, protectedDevices),
    ...(evidence?.batchMarker && evidence.daemonIndex !== undefined
      ? { bootedBy: `daemon${evidence.daemonIndex}` }
      : {}),
  };
}
