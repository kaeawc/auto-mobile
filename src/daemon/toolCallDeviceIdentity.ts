import type { DeviceDiscoveryError } from "../devices/deviceUtils";
import type { BootedDevice } from "../models";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import { isAndroidTransportAddressSerial } from "../utils/androidSerial";
import {
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

/**
 * Share a failed placement across a read's ingress, resolver and held-alias gate. Longer than
 * the 10 s device-list timeout, but shorter than the unproven-identity retry window; controls
 * always ask again, even immediately after a failed read.
 */
export const READ_TRANSPORT_LISTING_FAILURE_RETRY_MS = 15_000;

/** Entries kept per pool; a full memo is dropped whole (it is only a probe-rate limiter). */
const UNPROVEN_TRANSPORT_MEMO_LIMIT = 256;

/** Per pool: transports an ingress probe could not identify, and when it last tried. */
const unprovenTransportProbes = new WeakMap<object, Map<string, number>>();

/** Per pool and address: incomplete placement listings remembered only by reads. */
const failedReadTransportListings = new WeakMap<object, Map<string, number>>();

/** Whether a read should reuse missing discovery evidence instead of asking adb again. */
export function hasRecentReadTransportListingFailure(
  pool: ToolCallDeviceIdentityPool,
  deviceId: string,
  now: number,
): boolean {
  const memo = failedReadTransportListings.get(pool);
  const failedAt = memo?.get(deviceId);
  if (failedAt === undefined) {
    return false;
  }
  if (
    canonicalFrameDeviceId(pool, deviceId) !== deviceId ||
    !isUnfoldedTransportAddress(pool, deviceId) ||
    now - failedAt >= READ_TRANSPORT_LISTING_FAILURE_RETRY_MS
  ) {
    memo?.delete(deviceId);
    return false;
  }
  return true;
}

/** A full memo is dropped whole: neither rate limiter carries identity evidence. */
function rememberTransportProbe(memo: Map<string, number>, deviceId: string, now: number): void {
  if (memo.size >= UNPROVEN_TRANSPORT_MEMO_LIMIT) {
    memo.clear();
  }
  memo.set(deviceId, now);
}

/**
 * `args` with every caller-supplied device id as the pool's canonical id, from the pool's cached
 * fold only (no device I/O): the top-level `deviceId` every device tool, `setActiveDevice` and
 * `startDevice` take, and `killDevice`'s `device.deviceId`. Returns `args` itself when nothing
 * changes; never mutates it. Identity for iOS ids, for ids the pool has not folded, and with no
 * pool (direct mode). The cached half of {@link resolveToolCallDeviceIds}; called on its own only
 * where nothing may wait (the socket server's forward key).
 */
export function canonicalizeToolCallDeviceIds<T>(
  pool: ToolCallDeviceIdentityPool | undefined,
  args: T,
): T {
  if (!pool || !isRecord(args)) {
    return args;
  }
  const nested = args.device;
  return withDeviceIds(
    args,
    typeof args.deviceId === "string" ? canonicalFrameDeviceId(pool, args.deviceId) : undefined,
    isRecord(nested) && typeof nested.deviceId === "string"
      ? canonicalFrameDeviceId(pool, nested.deviceId)
      : undefined,
  );
}

/** `args` with its device ids replaced; `args` itself when both already are what it carries. */
function withDeviceIds<T extends Record<string, unknown>>(
  args: T,
  deviceId: string | undefined,
  nestedDeviceId: string | undefined,
): T {
  let result: Record<string, unknown> = args;
  if (deviceId !== undefined && deviceId !== args.deviceId) {
    result = { ...result, deviceId };
  }
  const nested = args.device;
  if (nestedDeviceId !== undefined && isRecord(nested) && nestedDeviceId !== nested.deviceId) {
    result = { ...result, device: { ...nested, deviceId: nestedDeviceId } };
  }
  return result as T;
}

/** Whether `args` carries a device id {@link resolveToolCallDeviceIds} would resolve. */
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

/** One `adb devices` listing as RAW rows, and whether it completed. */
export interface RawAndroidListing {
  devices: readonly BootedDevice[];
  /**
   * False when the listing failed, timed out or could not be asked: its rows say nothing about
   * which transports are connected, and an id missing from them is unknown, not absent.
   */
  complete: boolean;
  error?: DeviceDiscoveryError;
}

/** What a tool call may do to place a transport address the pool has never folded. */
export interface ToolCallDeviceIdProbe {
  /** Controls refuse an incomplete listing by default; reads always keep the id as sent. */
  refuseUnplaced?: boolean;
  /**
   * A fresh `adb devices` listing as RAW rows: each transport under its own serial, carrying its
   * own adb transport id. Never rows already mapped onto pooled ids (a readiness scan): a mapped
   * alias row is named like the canonical device but carries the alias's connection, and folding
   * it would record that connection as the canonical serial's and misroute the holder's dispatch.
   */
  listRawAndroidDevices: () => Promise<RawAndroidListing>;
  /**
   * The discovery funnel (`reconcileDiscoveryObservation`): handed the listing as pooled canonical
   * rows once it is folded, before the id is returned and any pool state is read for it.
   */
  reconcileDiscovery: (devices: readonly BootedDevice[]) => Promise<void>;
  /**
   * Whether the pool tracks an Android device. One it tracks may be held by a session, assigned
   * to a managed slot or claimed by another daemon, and an address a failed listing could not
   * place may be a second route to it. With none, there is nothing the address could be an alias
   * of: a host without adb (or without Android devices) is refused nothing here.
   */
  tracksAndroidDevice: () => boolean;
  /** The caller's clock, for the unproven-identity and failed-read retry windows. */
  now: number;
}

export interface ControlCallDeviceIdentityInput extends ToolCallDeviceIdProbe {
  pool: ToolCallDeviceIdentityPool | undefined;
  deviceId: string;
}

/**
 * THE entry point for a tool call's device ids (#11618): `args` with the top-level `deviceId` and
 * `killDevice`'s `device.deviceId` as the pool's canonical ids. Every path that takes a
 * caller-supplied id goes through here before any holder, managed-slot, routing, admission or
 * queue decision reads it: the MCP ingress, an internal call (plan step, nested tool) and the
 * execution-target resolver.
 *
 * With a `probe`, an address the pool has never folded is placed first
 * ({@link canonicalControlCallDeviceId}); reads set `refuseUnplaced: false` and are never refused.
 * Without a probe only the cached fold answers (the socket forward key). Returns `args` itself,
 * synchronously, when nothing changes and nothing needs a probe; never mutates it. Identity with no pool (direct mode).
 */
export function resolveToolCallDeviceIds<T>(
  pool: ToolCallDeviceIdentityPool | undefined,
  args: T,
  probe: ToolCallDeviceIdProbe | undefined,
): T | Promise<T> {
  if (!pool || !isRecord(args)) {
    return args;
  }
  if (!probe) {
    return canonicalizeToolCallDeviceIds(pool, args);
  }
  const resolve = (deviceId: unknown): string | Promise<string> | undefined =>
    typeof deviceId === "string"
      ? canonicalControlCallDeviceId({ ...probe, pool, deviceId })
      : undefined;
  const topLevel = resolve(args.deviceId);
  const nested = resolve(isRecord(args.device) ? args.device.deviceId : undefined);
  if (typeof topLevel !== "object" && typeof nested !== "object") {
    return withDeviceIds(args, topLevel, nested);
  }
  return Promise.all([topLevel, nested]).then(([top, inner]) => withDeviceIds(args, top, inner));
}

/**
 * A tool call's `deviceId` as the pool's canonical id, including a transport the pool has not
 * folded yet: a wireless id first named by a tool call, before any pool refresh saw it. Such an
 * address proves nothing about which handset answers on it, so it is probed and folded additively
 * (`canonicalizeFrameDiscovery`, as a direct frame does) before the holder check reads it.
 *
 * A FAILED listing never fails open for control calls. When `adb devices` does not complete, the
 * address cannot be placed; if the pool tracks an Android device it may be a second route to, the call is refused
 * typed and retryable (`discovery_incomplete`) instead of being judged as an unheld device. A
 * call naming a device by the id the pool holds it under never comes this far, so a holder is
 * never locked out of its own device by an adb failure. A transport that IS listed and whose
 * identity the pool cannot prove uses the shared held-alias rule: control is refused only
 * while it could alias a session or managed hold (#11596). Reads are never refused.
 *
 * Cost: an id the pool already holds or has folded, an emulator or USB serial and an iOS id are
 * answered from the pool's cached fold with no device I/O. Only an unfolded transport ADDRESS is
 * probed, and one the probe could not identify is not probed again for
 * {@link UNPROVEN_TRANSPORT_PROBE_RETRY_MS}; the pool's own refresh keeps retrying it meanwhile.
 * Reads share this probe, but keep the id as sent on an incomplete listing and reuse that failure
 * for {@link READ_TRANSPORT_LISTING_FAILURE_RETRY_MS}. The probe only
 * reads discovery/identity and updates the fold; it never readies a device.
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
    failedReadTransportListings.get(pool)?.delete(deviceId);
    return cached;
  }
  if (input.refuseUnplaced === false && hasRecentReadTransportListingFailure(pool, deviceId, now)) {
    return deviceId;
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
  const listing = await input.listRawAndroidDevices();
  if (!listing.complete) {
    if (input.refuseUnplaced === false) {
      const failures = failedReadTransportListings.get(pool) ?? new Map<string, number>();
      failedReadTransportListings.set(pool, failures);
      rememberTransportProbe(failures, deviceId, now);
    }
    // Control failures are never remembered: the next control sees a recovered adb at once.
    return unlistedTransportOutcome(input, listing.error);
  }
  failedReadTransportListings.get(pool)?.delete(deviceId);
  const android = listing.devices.filter((device) => device.platform === "android");
  const canonical = await canonicalizeFrameDiscovery(pool, "android", android, deviceId);
  await input.reconcileDiscovery(canonical.devices);
  const folded = canonical.deviceId;
  if (folded !== undefined && folded !== deviceId) {
    memo.delete(deviceId);
    return folded;
  }
  // Only a transport that was connected was probed; an absent one is looked for again next call.
  if (android.some((device) => device.deviceId === deviceId)) {
    rememberTransportProbe(memo, deviceId, now);
  }
  return deviceId;
}

/**
 * The answer for an address a failed listing said nothing about: controls refuse while the pool
 * tracks an Android device it may reach; reads always keep the id as sent.
 */
function unlistedTransportOutcome(
  input: ControlCallDeviceIdentityInput,
  discoveryError: DeviceDiscoveryError | undefined,
): string {
  if (input.refuseUnplaced === false || !input.tracksAndroidDevice()) {
    return input.deviceId;
  }
  const error = discoveryError ?? {
    code: "failed",
    message: "Android booted-device discovery did not complete.",
  };
  throw new AndroidBootedDeviceDiscoveryIncompleteError(
    error,
    `discovery_incomplete: Android transport '${input.deviceId}' could not be identified ` +
      `(${error.message}), so it cannot be told apart from a device the pool already tracks, ` +
      "which a session may hold; nothing was sent. Retry shortly, or name the device by the id " +
      "listDevices reports for it.",
  );
}

/** A bare ADB transport address the pool neither holds as a device nor has folded onto one. */
function isUnfoldedTransportAddress(pool: ToolCallDeviceIdentityPool, deviceId: string): boolean {
  return (
    isAndroidTransportAddressSerial(deviceId) &&
    !(pool.getAllDevices?.() ?? []).some((device) => device.id === deviceId)
  );
}
