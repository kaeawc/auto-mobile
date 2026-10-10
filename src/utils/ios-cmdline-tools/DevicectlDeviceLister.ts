import { promises as fs } from "fs";
import { trackAmbient } from "../PerfContext";
import { tmpdir } from "os";
import { join } from "path";
import type { ExecResult } from "../../models";
import type { CheckResult } from "../../models/CheckResult";
import type { BootedDevice } from "../../models/DeviceInfo";
import { errorMessage } from "../describeUnknownError";
import { DefaultHostCommandExecutor, type HostCommandOptions } from "../HostCommandExecutor";
import { logger, type Logger } from "../logger";
import { defaultTimer, type Timer } from "../SystemTimer";
import {
  defaultDiscoveryObservationSequence,
  type DiscoveryObservationSequence,
} from "../DiscoveryObservationSequence";
import {
  asRecord,
  asString,
  parseDevicectlFailureEnvelope,
  type DevicectlFailureEnvelope,
} from "./devicectlFailureEnvelope";
import { inferIosFormFactor, isIosPhysicalUdid, isIosSimulatorUdid } from "./iosDeviceType";

/** Minimal injected seam for the diagnostic-only devicectl availability probe. */
export interface DevicectlAvailabilityDependencies {
  platform: () => NodeJS.Platform;
  invoke: (
    file: string,
    args: string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<ExecResult>;
  logger: Pick<Logger, "warn">;
  probe?: { signal?: AbortSignal; timeoutMs?: number };
}

/** Checks devicectl without constructing a lister or enumerating devices. */
export async function checkDevicectlAvailability(
  dependencies: DevicectlAvailabilityDependencies,
): Promise<CheckResult> {
  if (dependencies.platform() !== "darwin") {
    return { name: "devicectl", status: "skip", message: "iOS development requires macOS" };
  }
  try {
    const result = await dependencies.invoke(
      "xcrun",
      ["devicectl", "--version"],
      dependencies.probe,
    );
    return {
      name: "devicectl",
      status: "pass",
      message: "devicectl functional",
      value: result.stdout,
    };
  } catch (error) {
    dependencies.logger.warn(`devicectl check failed: ${errorMessage(error)}`, error);
    return {
      name: "devicectl",
      status: "fail",
      message: `devicectl not functional: ${errorMessage(error)}`,
    };
  }
}

/**
 * Discovery seam for *physical* iOS devices attached to this host.
 *
 * Simulators come from `SimCtlClient`; this is the devicectl-backed other half,
 * so `MultiPlatformDeviceManager` can resolve a physical UDID to a
 * `BootedDevice` instead of rejecting it as "not booted" (issue #5620).
 *
 * Implementations must never throw: a host with no Xcode, no devicectl, or no
 * attached hardware degrades to an empty list.
 */
export interface IosPhysicalDeviceLister {
  listConnectedDevices(): Promise<PhysicalIosDeviceDiscovery>;
}

export type DevicectlListingErrorCode = "unavailable" | "failed" | "timeout";
export interface DevicectlListingError {
  code: DevicectlListingErrorCode;
  message: string;
  coreDeviceError?: DevicectlFailureEnvelope;
}

/** Invocation or envelope failures replay retained devices as incomplete. */
export type PhysicalIosDeviceDiscovery =
  | { devices: BootedDevice[]; complete: true }
  | {
      devices: BootedDevice[];
      complete: false;
      error: DevicectlListingError;
      /**
       * Devices positively recognized by THIS sweep, present only when it was
       * incomplete because some other record was unidentifiable. They stay fresh
       * even though the sweep is not authoritative about absences.
       */
      observedDeviceIds?: string[];
    };

type NotAvailableReason =
  | "non-ios"
  | "unreachable"
  | "booting"
  | "shutting-down"
  | "shutdown"
  | "not-booted";
export type DevicectlListingParse =
  | {
      ok: true;
      physical: BootedDevice[];
      simulators: BootedDevice[];
      notAvailable: Array<{ reason: NotAvailableReason }>;
      unidentified: string[];
    }
  | { ok: false; reason: string };

/**
 * `connectionProperties.tunnelState` values that mean "this device is known to
 * Xcode but is not reachable right now". Everything else — including a missing
 * or unrecognized state — is treated as connected.
 *
 * The bias is deliberate and asymmetric: the bug being fixed is a physical
 * device being wrongly rejected, so an unknown state must not re-introduce that
 * rejection. Only states devicectl documents as unreachable filter a device out.
 */
const UNREACHABLE_TUNNEL_STATES = new Set(["unavailable", "disconnected"]);

/**
 * `hardwareProperties.platform` values this lister accepts as an iOS device.
 *
 * A paired Apple Watch, Apple TV, or Vision Pro is a CoreDevice too, and they
 * use the same physical-UDID shapes — so the UDID pattern alone cannot tell them
 * apart. Without this gate they would be published as `platform: "ios"` and
 * route iOS operations to hardware that cannot serve them.
 *
 * A physical record with NO platform field is still accepted, keeping the same
 * degrade-toward-inclusion policy as {@link UNREACHABLE_TUNNEL_STATES}: older
 * devicectl payloads that omit the field must not lose their iPhones.
 */
const IOS_PLATFORM_VALUES = new Set(["ios", "ipados"]);
// These CoreDevice platforms are explicitly outside this iOS inventory; unknown values are drift.
const NON_IOS_PLATFORM_VALUES = new Set(["watchos", "tvos", "xros", "visionos"]);

/**
 * Pull the device array out of a `devicectl list devices --json-output` payload.
 * devicectl nests it under `result.devices`; tolerate a bare `devices` array and
 * a top-level array so a recognized alternate envelope remains readable. Unknown envelopes fail.
 */
function extractDeviceEntries(data: unknown): unknown[] | null {
  if (Array.isArray(data)) {
    return data;
  }
  const root = asRecord(data);
  if (!root) {
    return null;
  }
  const outcome = asRecord(root.info)?.outcome;
  if (outcome !== undefined && asString(outcome)?.toLowerCase() !== "success") {
    return null;
  }
  const devices = asRecord(root.result)?.devices ?? root.devices;
  return Array.isArray(devices) ? devices : null;
}

type DevicectlRecordOutcome =
  | { kind: "physical" | "simulator"; device: BootedDevice }
  | { kind: "not-available"; reason: NotAvailableReason }
  | { kind: "unidentifiable"; reason: string };

function readSoftwareVersion(
  properties: Record<string, unknown> | null,
  legacyState: Record<string, unknown> | null,
): string | undefined {
  const version = asRecord(properties?.software)?.osVersionNumber;
  return (
    asString(asRecord(version)?.stringValue) ??
    asString(version) ??
    asString(legacyState?.osVersionNumber)
  );
}

function readConnectionState(
  properties: Record<string, unknown> | null,
  record: Record<string, unknown>,
): string | undefined {
  return (
    asString(asRecord(properties?.connection)?.state) ??
    asString(asRecord(record.connectionProperties)?.tunnelState)
  )?.toLowerCase();
}

/** Shared field reader: modern properties take precedence per field over legacy keys. */
function readDeviceFields(record: Record<string, unknown>) {
  const properties = asRecord(record.properties);
  const hardware = asRecord(properties?.hardware);
  const legacyHardware = asRecord(record.hardwareProperties);
  const state = asRecord(properties?.state);
  const legacyState = asRecord(record.deviceProperties);
  const hardwareString = (key: string) =>
    asString(hardware?.[key]) ?? asString(legacyHardware?.[key]);
  const stateString = (key: string) => asString(state?.[key]) ?? asString(legacyState?.[key]);
  return {
    platform: hardwareString("platform")?.toLowerCase(),
    udid: hardwareString("udid") ?? asString(record.identifier),
    hardwareUdid: hardwareString("udid"),
    reality: hardwareString("reality"),
    visibilityClass: asString(record.visibilityClass) ?? asString(state?.visibilityClass),
    productType: hardwareString("productType"),
    name: stateString("name") ?? hardwareString("marketingName") ?? hardwareString("deviceType"),
    bootState: stateString("bootState"),
    connectionState: readConnectionState(properties, record),
    osVersion: readSoftwareVersion(properties, legacyState),
  };
}

/** Require iOS platform and hardware UDID alongside positive simulator kind evidence. */
function isRecognizedSimulator(fields: ReturnType<typeof readDeviceFields>): boolean {
  return (
    fields.platform !== undefined &&
    IOS_PLATFORM_VALUES.has(fields.platform) &&
    (fields.reality === "simulated" ||
      (fields.reality === undefined && fields.visibilityClass === "simulators")) &&
    fields.hardwareUdid !== undefined &&
    isIosSimulatorUdid(fields.hardwareUdid)
  );
}

function deviceKind(
  fields: ReturnType<typeof readDeviceFields>,
): "physical" | "simulator" | undefined {
  if (isRecognizedSimulator(fields)) {
    return "simulator";
  }
  // Preserve tested older physical payloads with no reality/platform field.
  if (
    fields.udid &&
    isIosPhysicalUdid(fields.udid) &&
    fields.visibilityClass !== "simulators" &&
    (fields.reality === undefined || fields.reality === "physical")
  ) {
    return "physical";
  }
  return undefined;
}

function unavailableReason(
  fields: ReturnType<typeof readDeviceFields>,
  kind: "physical" | "simulator",
): NotAvailableReason | undefined {
  // Availability never substitutes for positive kind evidence.
  if (kind === "simulator") {
    switch (fields.bootState?.toLowerCase()) {
      case "booted":
        break;
      case "booting":
        return "booting";
      case "shuttingdown":
        return "shutting-down";
      case "shutdown":
        return "shutdown";
      default:
        return "not-booted";
    }
    return fields.connectionState === "connected" ? undefined : "unreachable";
  }
  // Physical boot-state semantics need hardware evidence; preserve lenient availability.
  if (fields.connectionState && UNREACHABLE_TUNNEL_STATES.has(fields.connectionState)) {
    return "unreachable";
  }
  return undefined;
}

function udidShape(udid: string | undefined): string {
  if (!udid) {
    return "missing";
  }
  if (isIosPhysicalUdid(udid)) {
    return "physical";
  }
  return isIosSimulatorUdid(udid) ? "simulator" : "unrecognized";
}

/** Only fixed labels leave this reader: never log names, UDIDs, or unknown raw field values. */
function unidentifiedFields(fields: ReturnType<typeof readDeviceFields>): string {
  const platform =
    fields.platform === undefined
      ? "missing"
      : IOS_PLATFORM_VALUES.has(fields.platform)
        ? "ios"
        : "unknown";
  const reality =
    fields.reality === undefined
      ? "missing"
      : fields.reality === "physical" || fields.reality === "simulated"
        ? fields.reality
        : "unknown";
  const connection =
    fields.connectionState === undefined
      ? "missing"
      : fields.connectionState === "connected" ||
          UNREACHABLE_TUNNEL_STATES.has(fields.connectionState)
        ? fields.connectionState
        : "unknown";
  return `platform=${platform}, reality=${reality}, udid-shape=${udidShape(fields.udid)}, hardware-udid-shape=${udidShape(fields.hardwareUdid)}, connection-state=${connection}`;
}

/** Resolve kind contradictions before deliberately excluding a non-iOS platform. */
function classifyExcludedEntry(
  fields: ReturnType<typeof readDeviceFields>,
): DevicectlRecordOutcome | undefined {
  // Contradictory kind evidence must not be silently excluded by the platform filter.
  if (fields.reality === "physical" && fields.visibilityClass === "simulators") {
    return { kind: "unidentifiable", reason: unidentifiedFields(fields) };
  }
  if (fields.platform && NON_IOS_PLATFORM_VALUES.has(fields.platform)) {
    return { kind: "not-available", reason: "non-ios" };
  }
  if (fields.platform && !IOS_PLATFORM_VALUES.has(fields.platform)) {
    return { kind: "unidentifiable", reason: unidentifiedFields(fields) };
  }
  return undefined;
}

/** Every record needs positive classification before the listing can be authoritative. */
function classifyDeviceEntry(entry: unknown): DevicectlRecordOutcome {
  const record = asRecord(entry);
  if (!record) {
    return { kind: "unidentifiable", reason: "entry is not an object" };
  }
  const fields = readDeviceFields(record);
  const excluded = classifyExcludedEntry(fields);
  if (excluded) {
    return excluded;
  }
  const kind = deviceKind(fields);
  if (!kind || !fields.udid) {
    return { kind: "unidentifiable", reason: unidentifiedFields(fields) };
  }
  const reason = unavailableReason(fields, kind);
  if (reason) {
    return { kind: "not-available", reason };
  }
  const formFactor = inferIosFormFactor(fields.productType);
  return {
    kind,
    device: {
      name: fields.name ?? fields.udid,
      platform: "ios",
      deviceId: fields.udid,
      ...(fields.osVersion ? { iosVersion: fields.osVersion, osVersion: fields.osVersion } : {}),
      ...(formFactor ? { formFactor } : {}),
    },
  };
}

/** Parse both record kinds; the physical lister drops simulators at its boundary. */
export function parseDevicectlDeviceList(data: unknown): DevicectlListingParse {
  const entries = extractDeviceEntries(data);
  if (!entries) {
    return { ok: false, reason: "devicectl listing has a non-success outcome or no device array" };
  }
  const result: Extract<DevicectlListingParse, { ok: true }> = {
    ok: true,
    physical: [],
    simulators: [],
    notAvailable: [],
    unidentified: [],
  };
  for (const outcome of entries.map(classifyDeviceEntry)) {
    switch (outcome.kind) {
      case "physical":
        result.physical.push(outcome.device);
        break;
      case "simulator":
        result.simulators.push(outcome.device);
        break;
      case "not-available":
        result.notAvailable.push({ reason: outcome.reason });
        break;
      case "unidentifiable":
        result.unidentified.push(outcome.reason);
        break;
    }
  }
  for (const devices of [result.physical, result.simulators]) {
    devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }
  return result;
}

export function classifyDevicectlInvocationError(error: unknown): DevicectlListingErrorCode {
  const cause = asRecord(asRecord(error)?.cause ?? error);
  const message = commandStderr(cause) ?? errorMessage(error);
  if (
    cause?.code === "ENOENT" ||
    /unable to find utility ["']?devicectl|xcode-select: error|active developer path .* does not exist/i.test(
      message,
    )
  ) {
    return "unavailable";
  }
  if (cause?.killed === true || cause?.code === "ETIMEDOUT") {
    return "timeout";
  }
  return "failed";
}

function commandStderr(cause: Record<string, unknown> | null): string | undefined {
  const stderr = cause?.stderr;
  return Buffer.isBuffer(stderr) ? stderr.toString() : asString(stderr);
}

function commandExitDetails(cause: Record<string, unknown> | null): string[] {
  const details: string[] = [];
  const code = cause?.code;
  if (typeof code === "number") {
    details.push(`exit code ${code}`);
  } else if (typeof code === "string") {
    details.push(`error code ${code}`);
  }
  const signal = asString(cause?.signal);
  if (signal) {
    details.push(`signal ${signal}`);
  }
  return details;
}

function invocationFailureDetail(error: unknown, code: DevicectlListingErrorCode): string {
  if (code === "unavailable") {
    return "xcrun/devicectl not found";
  }
  if (code === "timeout") {
    return `timed out after ${DEVICE_LIST_TIMEOUT_MS} ms`;
  }
  const cause = asRecord(asRecord(error)?.cause ?? error);
  const details = commandExitDetails(cause);
  const stderr = commandStderr(cause)
    ?.split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  if (stderr) {
    details.push(stderr);
  }
  return details.join(": ") || "invocation failed";
}

/**
 * How long a devicectl listing is reused before re-shelling out.
 *
 * iOS booted-device resolution is a hot path — the app resources and the daemon's
 * device sweep both call it. Per issue #8623 findings, `devicectl list devices`
 * and `simctl list devices -j` each took about 0.2 s on devicectl 651.13.4.
 * The window is short enough that a freshly-plugged device shows up
 * within one sweep, and long enough that a burst of resource reads spawns one
 * process rather than one per read.
 */
const DEVICE_LIST_CACHE_TTL_MS = 3_000;

/**
 * Ceiling on one `devicectl list devices` invocation. Unbounded, a stalled
 * devicectl would hang every caller awaiting iOS discovery — including
 * simulator-only app-resource reads — and the shared in-flight promise would
 * wedge each later sweep behind it.
 */
const DEVICE_LIST_TIMEOUT_MS = 15_000;

/**
 * How long a failing sweep keeps reporting the devices the last good sweep
 * found.
 *
 * Without this, a single devicectl blip makes a connected iPhone vanish from
 * discovery, and the daemon's disconnect monitor starts counting misses against
 * a device that never went anywhere. Retaining last-known devices keeps the
 * iPhone in the discovered list while `complete: false` still tells callers the
 * sweep was not authoritative. The window is bounded so a permanently broken
 * devicectl eventually stops asserting hardware that may well be unplugged.
 */
const LAST_GOOD_RETENTION_MS = 60_000;

interface DevicectlDeviceListerDependencies {
  platform: () => NodeJS.Platform;
  timer: Pick<Timer, "now">;
  observationSequence: DiscoveryObservationSequence;
  execute: (file: string, args: string[], options: HostCommandOptions) => Promise<ExecResult>;
  readFile: (path: string) => Promise<string>;
  mkdtemp: (prefix: string) => Promise<string>;
  rm: (path: string) => Promise<void>;
  tmpdir: () => string;
  logger: Pick<Logger, "debug" | "warn">;
}

const defaultDependencies: DevicectlDeviceListerDependencies = {
  platform: () => process.platform,
  execute: (file, args, options) =>
    new DefaultHostCommandExecutor().executeCommand(file, args, options),
  readFile: async (path) => fs.readFile(path, "utf-8"),
  mkdtemp: async (prefix) => fs.mkdtemp(prefix),
  rm: async (path) => fs.rm(path, { recursive: true, force: true }),
  tmpdir,
  logger,
  timer: defaultTimer,
  observationSequence: defaultDiscoveryObservationSequence,
};

/**
 * Lists connected physical iOS devices via `xcrun devicectl list devices`.
 *
 * macOS-only and best-effort: incomplete listings log and replay last-good
 * physical devices for a bounded window; non-darwin hosts return a complete empty
 * list. Physical-device discovery is additive to the simulator list, so a
 * failure here must degrade iOS discovery to "simulators only" rather than
 * failing the whole sweep.
 */
export class DevicectlDeviceLister implements IosPhysicalDeviceLister {
  private readonly deps: DevicectlDeviceListerDependencies;
  private cache: {
    discovery: PhysicalIosDeviceDiscovery;
    observedAt: number;
    expiresAt: number;
  } | null = null;
  private lastGood: { devices: BootedDevice[]; observedAt: number; staleAfter: number } | null =
    null;
  private previousFailureKey: string | undefined;
  private previousUnidentifiedKey = "[]";
  private inFlight: Promise<PhysicalIosDeviceDiscovery> | null = null;

  constructor(dependencies: Partial<DevicectlDeviceListerDependencies> = {}) {
    this.deps = { ...defaultDependencies, ...dependencies };
  }

  async listConnectedDevices(): Promise<PhysicalIosDeviceDiscovery> {
    if (this.deps.platform() !== "darwin") {
      return { devices: [], complete: true };
    }
    const now = this.deps.timer.now();
    // A backward wall-clock adjustment makes cached freshness unknowable.
    // Re-list immediately rather than retaining a stale physical-device name.
    if (this.cache && now >= this.cache.observedAt && now < this.cache.expiresAt) {
      return this.cache.discovery;
    }
    // Concurrent sweeps share one devicectl process rather than racing two.
    this.inFlight ??= this.runListing().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runListing(): Promise<PhysicalIosDeviceDiscovery> {
    let tempDir: string | null = null;
    let invoking = false;
    try {
      // --json-output - works on devicectl 651.13.4 (#8623 findings), but older CoreDevice
      // versions are unverified. DeviceAppManager.ts also uses files; keep this temp file
      // until a minimum supported version is decided.
      tempDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "automobile-devicectl-devices-"));
      const jsonPath = join(tempDir, "devices.json");
      // The listing is deduped via `inFlight`, so this span attributes to
      // whichever caller triggered the shared run — one command, one leaf (see
      // PerfContext).
      invoking = true;
      await trackAmbient("devicectl list devices", () =>
        this.deps.execute(
          "xcrun",
          ["devicectl", "list", "devices", "--json-output", jsonPath, "--quiet"],
          // Deliberately NOT wired to the ambient abort signal: this listing is
          // shared across concurrent callers, so honoring one caller's
          // cancellation would cancel the process out from under the others. The
          // timeout is what bounds it.
          { timeoutMs: DEVICE_LIST_TIMEOUT_MS },
        ),
      );
      invoking = false;
      const raw = await this.deps.readFile(jsonPath);
      const data: unknown = JSON.parse(raw);
      const envelope = parseDevicectlFailureEnvelope(data);
      if (envelope) {
        return this.failedEnvelope(envelope);
      }
      const parsed = parseDevicectlDeviceList(data);
      if (!parsed.ok) {
        return this.failedListing("failed", parsed.reason);
      }
      this.logUnidentified(parsed.unidentified);
      this.deps.logger.debug(
        `[DevicectlDeviceLister] dropped ${parsed.simulators.length} simulator record(s); simctl owns simulator discovery`,
      );
      this.previousFailureKey = undefined;
      // An unrecognised record might be a known phone whose shape drifted, so the
      // sweep is not authoritative: replay last-good rather than let the omitted
      // device accrue disconnect misses.
      if (parsed.unidentified.length > 0) {
        return this.remember(
          {
            devices: parsed.physical,
            complete: false,
            observedDeviceIds: parsed.physical.map((device) => device.deviceId),
            error: {
              code: "failed",
              message:
                `devicectl listed ${parsed.unidentified.length} record(s) this daemon could not ` +
                "identify; replaying the last good physical device inventory",
            },
          },
          [],
        );
      }
      return this.remember({ devices: parsed.physical, complete: true });
    } catch (error) {
      const code = invoking ? classifyDevicectlInvocationError(error) : "failed";
      const envelope = invoking
        ? await this.readInvocationFailureEnvelope(tempDir, code)
        : undefined;
      if (envelope) {
        return this.failedEnvelope(envelope);
      }
      const detail = invoking ? invocationFailureDetail(error, code) : errorMessage(error);
      return this.failedListing(
        code,
        tempDir ? detail.replaceAll(tempDir, "<temporary directory>") : detail,
      );
    } finally {
      if (tempDir) {
        try {
          await this.deps.rm(tempDir);
        } catch (cleanupError) {
          this.deps.logger.warn(
            `[DevicectlDeviceLister] Failed to remove temporary device listing directory ${tempDir}: ${errorMessage(cleanupError)}`,
          );
        }
      }
    }
  }

  private async readInvocationFailureEnvelope(
    tempDir: string | null,
    code: DevicectlListingErrorCode,
  ): Promise<DevicectlFailureEnvelope | undefined> {
    if (!tempDir || code !== "failed") {
      return undefined;
    }
    try {
      const data: unknown = JSON.parse(await this.deps.readFile(join(tempDir, "devices.json")));
      return parseDevicectlFailureEnvelope(data);
    } catch (error) {
      // Safe because the file may simply not exist or contain incomplete JSON after invocation failure.
      this.deps.logger.debug("[DevicectlDeviceLister] Optional failure envelope could not be read");
      return undefined;
    }
  }

  private failedEnvelope(envelope: DevicectlFailureEnvelope): PhysicalIosDeviceDiscovery {
    const label = envelope.kind.replaceAll("-", " ");
    return this.failedListing(
      "failed",
      `CoreDeviceError ${envelope.code} (${label})`,
      [],
      envelope,
    );
  }

  private logUnidentified(reasons: string[]): void {
    // Sorted reasons plus occurrence indexes identify changes without retaining record contents.
    const key = JSON.stringify(reasons.toSorted().map((reason, index) => [reason, index]));
    if (reasons.length > 0 && key !== this.previousUnidentifiedKey) {
      // An unrecognisable record is not evidence that a known device disappeared; the
      // listing is reported incomplete, so surface the change at warn (once per change).
      this.deps.logger.warn(
        `[DevicectlDeviceLister] ${reasons.length} devicectl record(s) could not be identified: ${reasons.join("; ")}`,
      );
    }
    this.previousUnidentifiedKey = key;
  }

  private failedListing(
    code: DevicectlListingErrorCode,
    detail: string,
    recognized: BootedDevice[] = [],
    coreDeviceError?: DevicectlListingError["coreDeviceError"],
  ): PhysicalIosDeviceDiscovery {
    const error: DevicectlListingError = {
      code,
      message: `devicectl could not list physical iOS devices (${code}): ${detail.split(/\r?\n/, 1)[0]}`,
      ...(coreDeviceError ? { coreDeviceError } : {}),
    };
    const message = `[DevicectlDeviceLister] ${error.message}`;
    const key = `${code}:${coreDeviceError?.kind ?? "invocation"}`;
    if (this.previousFailureKey === key) {
      // Repeated host-tool failures are expected until the host configuration changes.
      this.deps.logger.debug(message);
    } else {
      this.deps.logger.warn(message);
    }
    this.previousFailureKey = key;
    return this.remember({ devices: [], complete: false, error }, recognized);
  }

  private remember(
    discovery: PhysicalIosDeviceDiscovery,
    recognized: BootedDevice[] = [],
  ): PhysicalIosDeviceDiscovery {
    const now = this.deps.timer.now();
    const observedAt = this.deps.observationSequence.next();
    // A cache hit or retained result must retain when it was observed, rather
    // than appear newer merely because a later caller read it.
    const stamped = {
      ...discovery,
      devices: [...discovery.devices, ...recognized].map((device) => ({
        ...device,
        observedAt: device.observedAt ?? observedAt,
      })),
    };
    let resolved: PhysicalIosDeviceDiscovery;
    if (stamped.complete) {
      resolved = this.recordLastGood(stamped, now);
    } else {
      const devices = new Map(
        [...this.retainedDevices(now), ...stamped.devices].map((device) => [
          device.deviceId,
          device,
        ]),
      );
      resolved = {
        devices: [...devices.values()],
        complete: false,
        error: stamped.error,
        ...(stamped.observedDeviceIds ? { observedDeviceIds: stamped.observedDeviceIds } : {}),
      };
    }
    this.cache = {
      discovery: resolved,
      observedAt: now,
      expiresAt: now + DEVICE_LIST_CACHE_TTL_MS,
    };
    return resolved;
  }

  private recordLastGood(
    discovery: PhysicalIosDeviceDiscovery,
    now: number,
  ): PhysicalIosDeviceDiscovery {
    this.lastGood = {
      devices: discovery.devices,
      observedAt: now,
      staleAfter: now + LAST_GOOD_RETENTION_MS,
    };
    return discovery;
  }

  /** Devices the last good sweep found, while still inside the retention window. */
  private retainedDevices(now: number): BootedDevice[] {
    if (!this.lastGood || now >= this.lastGood.staleAfter) {
      this.lastGood = null;
      return [];
    }
    if (now < this.lastGood.observedAt) {
      this.lastGood.observedAt = now;
      this.lastGood.staleAfter = now + LAST_GOOD_RETENTION_MS;
    }
    return this.lastGood.devices;
  }
}

let sharedDevicectlDeviceLister: DevicectlDeviceLister | null = null;

/**
 * Process-wide physical-device lister (#11063). Every discovery path — the
 * device-manager singleton, per-session readiness scans, and tool handlers —
 * shares one TTL cache, one in-flight `devicectl` sweep, and one last-good
 * retention window, so a burst of callers spawns one process and a single
 * devicectl blip cannot drop an iPhone from one path while another keeps it.
 */
export function getSharedDevicectlDeviceLister(): DevicectlDeviceLister {
  sharedDevicectlDeviceLister ??= new DevicectlDeviceLister();
  return sharedDevicectlDeviceLister;
}
