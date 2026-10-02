import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { z } from "zod/v4";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ensureAndroidRoot } from "../../utils/android-cmdline-tools/ensureAndroidRoot";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";

export const MIN_DEVICE_CLOCK_INSTANT_MS = Date.parse("2000-01-01T00:00:00Z");
export const MAX_DEVICE_CLOCK_INSTANT_MS = Date.parse("2100-01-01T00:00:00Z");
/** Ten 365-day years; independent of calendar leap years. */
export const MAX_DEVICE_CLOCK_ADVANCE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** Epoch-second commands lose at most 999ms; allow one additional second of execution. */
export const DEVICE_CLOCK_TOLERANCE_MS = 2000;
export const deviceClockInputSchema = z.union([
  z
    .object({
      mode: z.literal("set"),
      instant: z.iso
        .datetime({ offset: true })
        .refine(
          (value) => clockInstantInWindow(Date.parse(value)),
          "Clock instant must be within 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z",
        ),
    })
    .strict(),
  z
    .object({
      mode: z.literal("advance"),
      byMs: z.number().int().min(1000).max(MAX_DEVICE_CLOCK_ADVANCE_MS),
    })
    .strict(),
  z.object({ mode: z.literal("reset") }).strict(),
]);
export class DeviceClockValidationError extends ActionableError {}
export type SetDeviceClockInput = z.infer<typeof deviceClockInputSchema>;
export interface DeviceClockState {
  supported: boolean;
  capability: "full" | "unsupported";
  instant?: string;
  automaticTime?: boolean;
  mode?: SetDeviceClockInput["mode"];
  requestedInstant?: string;
  appliedInstant?: string;
  readBack?: boolean;
  verified?: boolean;
  toleranceMs?: number;
  error?: string;
  outcome?: "changed" | "unchanged" | "restored";
}
export interface DeviceClockAdapter {
  canRoot(): Promise<boolean>;
  ensureRoot(): Promise<{ success: true; rootedByUs: boolean } | { success: false; error: string }>;
  unroot(): Promise<void>;
  readInstantMs(): Promise<number>;
  readAutomaticTime(): Promise<0 | 1>;
  setAutomaticTime(value: 0 | 1): Promise<void>;
  setInstantMs(instantMs: number): Promise<void>;
}
export interface DeviceClockRestoreState {
  initialAutomaticTime: 0 | 1;
  clockChangedByUs: boolean;
  rootedByUs: boolean;
}
export interface DeviceClockRestoreSlot {
  get(): DeviceClockRestoreState | undefined;
  record(value: DeviceClockRestoreState): void;
  clear(): void;
}

/** Sessionless callers retain ownership until explicit reset or device removal. */
export class DeviceClockRestoreRegistry {
  private readonly devices = new Map<string, { state?: DeviceClockRestoreState }>();

  slot(deviceId: string): DeviceClockRestoreSlot {
    let entry = this.devices.get(deviceId);
    if (!entry) {
      entry = {};
      this.devices.set(deviceId, entry);
    }
    const captured = entry;
    return {
      get: () => captured.state,
      record: (state) => {
        // A removed device must not regain ownership from a late mutation.
        if (this.devices.get(deviceId) === captured) {
          captured.state = state;
        }
      },
      clear: () => {
        captured.state = undefined;
        if (this.devices.get(deviceId) === captured) {
          this.devices.delete(deviceId);
        }
      },
    };
  }

  retire(deviceId: string): void {
    const entry = this.devices.get(deviceId);
    if (entry) {
      entry.state = undefined;
      this.devices.delete(deviceId);
    }
  }
}
export const defaultDeviceClockRestoreRegistry = new DeviceClockRestoreRegistry();

export interface DeviceClockDependencies {
  hostClock: Pick<Timer, "now">;
  invalidate(deviceId: string): void;
  restoreRegistry?: Pick<DeviceClockRestoreRegistry, "slot">;
}
export interface PreparedDeviceClock {
  targetMs: number;
  startMs: number;
}
const defaultDependencies: DeviceClockDependencies = {
  hostClock: defaultTimer,
  invalidate: () => {},
};
function clockInstantInWindow(value: number): boolean {
  return value >= MIN_DEVICE_CLOCK_INSTANT_MS && value <= MAX_DEVICE_CLOCK_INSTANT_MS;
}
/** Read-only preflight: cumulative bounds must be checked before ANY field is applied. */
export async function prepareDeviceClock(
  device: BootedDevice,
  adapter: DeviceClockAdapter,
  input: SetDeviceClockInput,
): Promise<PreparedDeviceClock | undefined> {
  validateDeviceClockInput(input);
  if (
    input.mode === "reset" ||
    device.platform !== "android" ||
    !isAndroidEmulatorSerial(device.deviceId)
  ) {
    return undefined;
  }
  if (!(await adapter.canRoot())) {
    return undefined;
  }
  const startMs = await adapter.readInstantMs();
  const targetMs = input.mode === "set" ? Date.parse(input.instant) : startMs + input.byMs;
  if (!clockInstantInWindow(targetMs)) {
    throw new DeviceClockValidationError(
      "Requested clock instant must be within 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z (inclusive).",
    );
  }
  return { targetMs, startMs };
}

/** All clock device command strings are owned by this adapter. */
export class AndroidDeviceClockAdapter implements DeviceClockAdapter {
  constructor(
    private readonly adb: Pick<AdbExecutor, "executeCommand">,
    private readonly signal?: AbortSignal,
  ) {}
  async canRoot(): Promise<boolean> {
    const id = await this.command("shell id");
    return (
      id.includes("uid=0(root)") || (await this.command("shell getprop ro.debuggable")) === "1"
    );
  }
  async ensureRoot(): Promise<
    { success: true; rootedByUs: boolean } | { success: false; error: string }
  > {
    const before = await this.command("shell id");
    if (before.includes("uid=0(root)")) {
      return { success: true, rootedByUs: false };
    }
    const result = await ensureAndroidRoot(this.adb, this.signal);
    return result.success ? { success: true, rootedByUs: true } : result;
  }
  async unroot(): Promise<void> {
    await this.command("unroot");
    await this.command("wait-for-device", 60_000);
  }
  private async command(command: string, timeoutMs = 30_000): Promise<string> {
    this.signal?.throwIfAborted();
    const result = await this.adb.executeCommand(command, timeoutMs, undefined, true, this.signal);
    this.signal?.throwIfAborted();
    if (
      result.error ||
      result.stderr.trim() ||
      outputLooksLikeShellFailure(result.stdout, result.stderr)
    ) {
      throw new ActionableError(`Device clock command failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  }
  async readInstantMs(): Promise<number> {
    const value = await this.command("shell date +%s");
    const milliseconds = Number(value) * 1000;
    if (
      !/^-?\d+$/.test(value) ||
      !Number.isSafeInteger(milliseconds) ||
      !Number.isFinite(new Date(milliseconds).getTime())
    ) {
      throw new ActionableError(
        "Device date +%s did not return a valid epoch second. Check device shell support.",
      );
    }
    return milliseconds;
  }
  async readAutomaticTime(): Promise<0 | 1> {
    const value = await this.command("shell settings get global auto_time");
    if (value !== "0" && value !== "1") {
      throw new ActionableError("Device auto_time must report 0 or 1 before changing its clock.");
    }
    return value === "1" ? 1 : 0;
  }
  async setAutomaticTime(value: 0 | 1): Promise<void> {
    await this.command(`shell settings put global auto_time ${value}`);
  }
  async setInstantMs(instantMs: number): Promise<void> {
    await this.command(`shell date -u @${Math.floor(instantMs / 1000)}`);
  }
}
export function validateDeviceClockInput(input: unknown): asserts input is SetDeviceClockInput {
  if (!deviceClockInputSchema.safeParse(input).success) {
    throw new DeviceClockValidationError(
      "Invalid clock input. Use set with an ISO-8601 instant including Z or an offset, set within 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z, advance with integer byMs >= 1000 up to MAX_DEVICE_CLOCK_ADVANCE_MS, or reset.",
    );
  }
}
function unsupported(device: BootedDevice): DeviceClockState | undefined {
  if (device.platform === "ios") {
    return {
      supported: false,
      capability: "unsupported",
      error:
        "Real clock control/read-back is unsupported on iOS simulators and devices; status-bar overrides do not change the clock.",
    };
  }
  return undefined;
}
export async function readDeviceClock(
  device: BootedDevice,
  adapter: DeviceClockAdapter,
): Promise<DeviceClockState> {
  const limitation = unsupported(device);
  if (limitation) {
    return limitation;
  }
  try {
    const instant = new Date(await adapter.readInstantMs()).toISOString();
    const automaticTime = (await adapter.readAutomaticTime()) === 1;
    return { supported: true, capability: "full", instant, automaticTime, readBack: true };
  } catch (error) {
    logger.warn(`Failed to read device clock for ${device.deviceId}`, error);
    return {
      supported: true,
      capability: "full",
      error: `Failed to read device clock: ${errorMessage(error)}`,
    };
  }
}
interface ClockMutationContext {
  device: BootedDevice;
  adapter: DeviceClockAdapter;
  slot?: DeviceClockRestoreSlot;
  dependencies: DeviceClockDependencies;
  recorded?: DeviceClockRestoreState;
  rootedByUs: boolean;
}
/** A read failure is a field failure; a bad cumulative target is an input error. */
export async function preflightDeviceClock(
  device: BootedDevice,
  adapter: DeviceClockAdapter,
  input: SetDeviceClockInput,
): Promise<{ prepared?: PreparedDeviceClock; failure?: DeviceClockState }> {
  try {
    return { prepared: await prepareDeviceClock(device, adapter, input) };
  } catch (error) {
    if (error instanceof DeviceClockValidationError) {
      throw error;
    }
    logger.warn(`Failed to preflight clock for ${device.deviceId}`, error);
    return { failure: clockFailure(error) };
  }
}
function clockWriteLimitation(device: BootedDevice): DeviceClockState | undefined {
  const ios = unsupported(device);
  if (ios) {
    return ios;
  }
  if (!isAndroidEmulatorSerial(device.deviceId)) {
    return {
      supported: false,
      capability: "unsupported",
      verified: false,
      error:
        "Clock control is unsupported on physical Android devices; nothing to reset. Use a rootable Android emulator.",
    };
  }
  return undefined;
}
function refusedClockRoot(
  recorded: DeviceClockRestoreState | undefined,
  error: string,
): DeviceClockState {
  return {
    supported: Boolean(recorded),
    capability: recorded ? "full" : "unsupported",
    verified: false,
    error: `Clock control requires a rootable Android emulator; Play Store images refuse root. ${recorded ? "Restore remains pending." : "Nothing to reset."} ${error}`,
  };
}
async function resolveClockPreflight(
  device: BootedDevice,
  adapter: DeviceClockAdapter,
  input: SetDeviceClockInput,
  prepared?: PreparedDeviceClock,
): Promise<{ prepared?: PreparedDeviceClock; failure?: DeviceClockState }> {
  if (prepared) {
    return { prepared };
  }
  return input.mode === "advance" ? preflightDeviceClock(device, adapter, input) : {};
}
async function unwindUnrecordedRoot(context: ClockMutationContext): Promise<void> {
  if (context.rootedByUs && !context.slot?.get()) {
    await unrootBestEffort(context.adapter, context.device.deviceId);
  }
}
export async function writeDeviceClock(
  device: BootedDevice,
  adapter: DeviceClockAdapter,
  input: SetDeviceClockInput,
  slot?: DeviceClockRestoreSlot,
  dependencies: DeviceClockDependencies = defaultDependencies,
  prepared?: PreparedDeviceClock,
): Promise<DeviceClockState> {
  validateDeviceClockInput(input);
  const limitation = clockWriteLimitation(device);
  if (limitation) {
    return limitation;
  }
  slot ??= (dependencies.restoreRegistry ?? defaultDeviceClockRestoreRegistry).slot(
    device.deviceId,
  );
  // Presence comes before rooting: ownership makes refused root a pending restore failure.
  const recorded = slot.get();
  const preflight = await resolveClockPreflight(device, adapter, input, prepared);
  if (preflight.failure) {
    return preflight.failure;
  }
  const context: ClockMutationContext = {
    device,
    adapter,
    slot,
    dependencies,
    recorded,
    rootedByUs: false,
  };
  try {
    const root = await adapter.ensureRoot();
    if (!root.success) {
      return refusedClockRoot(recorded, root.error);
    }
    context.rootedByUs = root.rootedByUs;
    if (recorded) {
      recorded.rootedByUs ||= root.rootedByUs;
    }
    return input.mode === "reset"
      ? await resetDeviceClock(context)
      : await applyDeviceClock(context, input, preflight.prepared);
  } catch (error) {
    logger.warn(`Failed to change device clock for ${device.deviceId}`, error);
    // Root was acquired but no clock ownership was recorded: unwind just adbd.
    await unwindUnrecordedRoot(context);
    return clockFailure(error);
  }
}
async function resetDeviceClock(context: ClockMutationContext): Promise<DeviceClockState> {
  const { device, adapter, recorded, slot, dependencies, rootedByUs } = context;
  const state = recorded ?? { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs };
  if (!recorded) {
    slot?.record(state);
  }
  const result = await restoreDeviceClock(device, adapter, state, dependencies);
  if (result.verified) {
    slot?.clear();
  }
  return result;
}
async function unchangedDeviceClock(
  context: ClockMutationContext,
  instant: string,
): Promise<DeviceClockState> {
  const { device, adapter, recorded, rootedByUs } = context;
  if (rootedByUs && !recorded) {
    await unrootBestEffort(adapter, device.deviceId);
  }
  return {
    ...(await readDeviceClock(device, adapter)),
    mode: "set",
    outcome: "unchanged",
    requestedInstant: instant,
    toleranceMs: DEVICE_CLOCK_TOLERANCE_MS,
  };
}
function clockWriteVerified(
  result: DeviceClockState,
  input: SetDeviceClockInput,
  target: PreparedDeviceClock,
): boolean {
  const actualMs = result.instant === undefined ? NaN : Date.parse(result.instant);
  const moved =
    input.mode !== "advance" ||
    actualMs - target.startMs >=
      Math.max(1000, Math.floor(input.byMs / 1000) * 1000 - DEVICE_CLOCK_TOLERANCE_MS);
  return (
    result.automaticTime === false &&
    moved &&
    Math.abs(actualMs - target.targetMs) <= DEVICE_CLOCK_TOLERANCE_MS
  );
}
async function applyDeviceClock(
  context: ClockMutationContext,
  input: Exclude<SetDeviceClockInput, { mode: "reset" }>,
  prepared?: PreparedDeviceClock,
): Promise<DeviceClockState> {
  const { device, adapter, recorded, slot, dependencies, rootedByUs } = context;
  const target = prepared ?? (await prepareDeviceClock(device, adapter, input));
  if (!target) {
    throw new ActionableError("Device clock target could not be prepared");
  }
  if (
    input.mode === "set" &&
    Math.abs(target.startMs - target.targetMs) <= DEVICE_CLOCK_TOLERANCE_MS
  ) {
    return unchangedDeviceClock(context, input.instant);
  }
  const state = recorded ?? {
    initialAutomaticTime: await adapter.readAutomaticTime(),
    clockChangedByUs: true,
    rootedByUs,
  };
  slot?.record(state);
  await adapter.setAutomaticTime(0);
  try {
    await adapter.setInstantMs(target.targetMs);
  } finally {
    // A rejected date command can still have changed the device clock.
    dependencies.invalidate(device.deviceId);
  }
  const result = await readDeviceClock(device, adapter);
  const verified = clockWriteVerified(result, input, target);
  return {
    ...result,
    mode: input.mode,
    outcome: "changed",
    verified,
    requestedInstant: new Date(target.targetMs).toISOString(),
    appliedInstant: new Date(Math.floor(target.targetMs / 1000) * 1000).toISOString(),
    toleranceMs: DEVICE_CLOCK_TOLERANCE_MS,
    ...(!verified
      ? {
          error:
            "Device clock read-back did not match the target, requested advance, or auto_time remained enabled.",
        }
      : {}),
  };
}
export function clockFailure(error: unknown): DeviceClockState {
  return {
    supported: true,
    capability: "full",
    verified: false,
    error: `Failed to change device clock: ${errorMessage(error)}`,
  };
}
async function unrootBestEffort(adapter: DeviceClockAdapter, deviceId: string): Promise<void> {
  try {
    await adapter.unroot();
  } catch (error) {
    logger.warn(`Clock restored but failed to unroot ${deviceId}`, error);
  }
}
/** Restore real host time even when the original automatic time was disabled. */
export async function restoreDeviceClock(
  device: BootedDevice,
  adapter: DeviceClockAdapter,
  state: DeviceClockRestoreState,
  dependencies: DeviceClockDependencies,
): Promise<DeviceClockState> {
  await adapter.setAutomaticTime(0);
  const target = dependencies.hostClock.now();
  try {
    await adapter.setInstantMs(target);
  } finally {
    dependencies.invalidate(device.deviceId);
  }
  await adapter.setAutomaticTime(state.initialAutomaticTime);
  const result = await readDeviceClock(device, adapter);
  const verified =
    result.automaticTime === (state.initialAutomaticTime === 1) &&
    result.instant !== undefined &&
    Math.abs(Date.parse(result.instant) - dependencies.hostClock.now()) <=
      DEVICE_CLOCK_TOLERANCE_MS;
  if (verified && state.rootedByUs) {
    await unrootBestEffort(adapter, device.deviceId);
  }
  return {
    ...result,
    mode: "reset",
    outcome: "restored",
    verified,
    toleranceMs: DEVICE_CLOCK_TOLERANCE_MS,
    ...(!verified
      ? {
          error:
            "Host time and original auto_time restoration did not verify; restore remains pending.",
        }
      : {}),
  };
}
