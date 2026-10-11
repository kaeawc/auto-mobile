import type { BootedDevice } from "../models";
import { isAndroidTransportAddressSerial } from "../utils/androidSerial";
import {
  assertFrameTargetIdentityProven,
  canonicalFrameDeviceId,
  canonicalizeFrameDiscovery,
  type FrameDeviceIdentityPool,
} from "./frameDeviceIdentity";

/**
 * The device ids a `tools/call` carries, as the pool's canonical ids (#11618). One handset
 * reachable over USB and wireless debugging is ONE pooled device held under one id; a tool call
 * may name it by either. Every holder, managed-slot, routing, admission and forward-key decision
 * is keyed on the canonical id, so the call's ids are resolved once at the ingress and nothing
 * downstream sees an alias. The resolution itself is `frameDeviceIdentity.ts`, shared with the
 * direct socket frames (#11596).
 */
export type ToolCallDeviceIdentityPool = FrameDeviceIdentityPool;

/** How long an ingress probe that proved nothing is trusted before the transport is probed again. */
export const UNPROVEN_TRANSPORT_PROBE_RETRY_MS = 30_000;

/** Entries kept per pool; a full memo is dropped whole (it is only a probe-rate limiter). */
const UNPROVEN_TRANSPORT_MEMO_LIMIT = 256;

/** Per pool: transports an ingress probe could not identify, and when it last tried. */
const unprovenTransportProbes = new WeakMap<object, Map<string, number>>();

/**
 * `args` with every caller-supplied device id as the pool's canonical id, from the pool's cached
 * fold only (no device I/O): the top-level `deviceId` every device tool, `setActiveDevice` and
 * `startDevice` take, and `killDevice`'s `device.deviceId`. Returns `args` itself when nothing
 * changes; never mutates it. Identity for iOS ids, for ids the pool has not folded, and with no
 * pool (direct mode).
 */
export function canonicalizeToolCallDeviceIds<T>(
  pool: ToolCallDeviceIdentityPool | undefined,
  args: T,
): T {
  if (!pool || !isRecord(args)) {
    return args;
  }
  let result: Record<string, unknown> = args;
  if (typeof args.deviceId === "string") {
    const canonical = canonicalFrameDeviceId(pool, args.deviceId);
    if (canonical !== args.deviceId) {
      result = { ...result, deviceId: canonical };
    }
  }
  const nested = args.device;
  if (isRecord(nested) && typeof nested.deviceId === "string") {
    const canonical = canonicalFrameDeviceId(pool, nested.deviceId);
    if (canonical !== nested.deviceId) {
      result = { ...result, device: { ...nested, deviceId: canonical } };
    }
  }
  return result as T;
}

/** Whether `args` carries a device id {@link canonicalizeToolCallDeviceIds} would resolve. */
export function toolCallNamesDeviceId(args: unknown): boolean {
  return (
    isRecord(args) &&
    (typeof args.deviceId === "string" ||
      (isRecord(args.device) && typeof args.device.deviceId === "string"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ControlCallDeviceIdentityInput {
  pool: ToolCallDeviceIdentityPool | undefined;
  deviceId: string;
  /** The call's own connected-device scan (Android rows are used; others are ignored). */
  listConnectedDevices: () => Promise<readonly BootedDevice[]>;
  /** The caller's clock, for {@link UNPROVEN_TRANSPORT_PROBE_RETRY_MS}. */
  now: number;
}

/**
 * A CONTROL call's `deviceId` as the pool's canonical id, including a transport the pool has not
 * folded yet: a wireless id first named by a tool call, before any pool refresh saw it. Such an
 * address proves nothing about which handset answers on it, so it is probed and folded additively
 * (`canonicalizeFrameDiscovery`, as a direct frame does) before the holder check reads it.
 *
 * Cost: an id the pool already holds or has folded, an emulator or USB serial and an iOS id are
 * answered from the pool's cached fold with no device I/O. Only an unfolded transport ADDRESS is
 * probed, and one the probe could not identify is not probed again for
 * {@link UNPROVEN_TRANSPORT_PROBE_RETRY_MS}; the pool's own refresh keeps retrying it meanwhile.
 * Reads never come here: they hold nothing, so they resolve from the cached fold alone.
 *
 * Returns the id synchronously whenever no probe is needed, so an ordinary call gains no extra
 * turn at the ingress; a promise only for a first-seen transport.
 */
export function canonicalControlCallDeviceId(
  input: ControlCallDeviceIdentityInput,
): string | Promise<string> {
  const { pool, deviceId, now } = input;
  if (!pool) {
    return deviceId;
  }
  const cached = canonicalFrameDeviceId(pool, deviceId);
  if (cached !== deviceId || !isUnfoldedTransportAddress(pool, deviceId)) {
    unprovenTransportProbes.get(pool)?.delete(deviceId);
    return cached;
  }
  const memo = unprovenTransportProbes.get(pool) ?? new Map<string, number>();
  unprovenTransportProbes.set(pool, memo);
  const probedAt = memo.get(deviceId);
  if (probedAt !== undefined && now - probedAt < UNPROVEN_TRANSPORT_PROBE_RETRY_MS) {
    return deviceId;
  }
  return foldFirstSeenTransport(pool, memo, input);
}

/** Probe and fold a transport address the pool has never folded; remember one it cannot prove. */
async function foldFirstSeenTransport(
  pool: ToolCallDeviceIdentityPool,
  memo: Map<string, number>,
  input: ControlCallDeviceIdentityInput,
): Promise<string> {
  const { deviceId, now } = input;
  const android = (await input.listConnectedDevices()).filter(
    (device) => device.platform === "android",
  );
  const folded = (await canonicalizeFrameDiscovery(pool, "android", android, deviceId)).deviceId;
  if (folded !== undefined && folded !== deviceId) {
    memo.delete(deviceId);
    return folded;
  }
  // Only a transport that was connected was probed; an absent one is looked for again next call.
  if (android.some((device) => device.deviceId === deviceId)) {
    if (memo.size >= UNPROVEN_TRANSPORT_MEMO_LIMIT) {
      memo.clear();
    }
    memo.set(deviceId, now);
  }
  return deviceId;
}

/** A bare ADB transport address the pool neither holds as a device nor has folded onto one. */
function isUnfoldedTransportAddress(pool: ToolCallDeviceIdentityPool, deviceId: string): boolean {
  return (
    isAndroidTransportAddressSerial(deviceId) &&
    !(pool.getAllDevices?.() ?? []).some((device) => device.id === deviceId)
  );
}

/**
 * OPEN OWNER DECISION (#11596, #11618): may a control tool call drive an UNHELD device on an
 * Android transport the pool cannot identify (an emulator on a non-loopback `adb connect`
 * address; a wireless phone reporting a generic serial)? The pool cannot prove such a transport is
 * NOT a second route to a device a session holds, and it cannot prove it is one either.
 *
 * Today the MCP ingress allows it, as it always has; a transport the pool CAN prove is an alias of
 * a held device never reaches this question (it was resolved to the held id and refused by the
 * holder check). This predicate is the one place the answer lives for tool calls: returning false
 * makes {@link assertToolTargetIdentityProven} apply the direct frames' rule
 * (`assertFrameTargetIdentityProven`), so frames and tools change together.
 */
export function mayControlUnheldUnidentifiedTransport(): boolean {
  return true;
}

/**
 * The tool-call side of `assertFrameTargetIdentityProven`, gated on
 * {@link mayControlUnheldUnidentifiedTransport}. A no-op while the owner decision is open.
 */
export function assertToolTargetIdentityProven(
  pool: ToolCallDeviceIdentityPool | undefined,
  deviceId: string,
  toolName: string,
  heldBySession: boolean,
): void {
  if (mayControlUnheldUnidentifiedTransport() || !isAndroidTransportAddressSerial(deviceId)) {
    return;
  }
  assertFrameTargetIdentityProven(
    pool,
    { deviceId, name: deviceId, platform: "android" },
    toolName,
    heldBySession,
  );
}
