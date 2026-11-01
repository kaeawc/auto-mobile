import type { BootedDevice } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import {
  DEVICE_CONDITION_APPLY,
  integrityStateParamsSchema,
  type DeviceConditionIntegrityParams,
  type DeviceConditionKey,
  type DeviceConditionSignalId,
  type DeviceConditionSignalResult,
} from "./DeviceConditionTypes";
import { readIntegritySignals, SU_PATHS, SUPERUSER_APK } from "./integritySignals";
import { adbCommand, createSerializer, rejectValue, shell } from "./injectorSupport";
import {
  ensureRootAdb,
  listExisting,
  plantArtifacts,
  remountWritable,
  ROOT_ARTIFACT_PATHS,
} from "./rootStateInjector";
import { SelinuxOwner, resolveSelinuxOwner, selinuxOwnersByDevice } from "./SelinuxOwner";
import { ArtifactOwner, artifactOwnersByDevice, resolveArtifactOwner } from "./ArtifactOwner";
import { OwedResetError } from "./OwedResetError";

const TOGGLE_IDS = ["su-binary", "superuser-apk", "selinux-permissive"] as const;
type ToggleId = (typeof TOGGLE_IDS)[number];
const isToggle = (id: DeviceConditionSignalId): id is ToggleId =>
  TOGGLE_IDS.some((key) => key === id);
const pathsFor = (id: ToggleId): readonly string[] =>
  id === "su-binary"
    ? SU_PATHS.filter((path) => path.endsWith("/su"))
    : id === "superuser-apk"
      ? [SUPERUSER_APK]
      : [];

interface SignalState {
  active: boolean;
  paths: Set<string>;
}
interface Mutation {
  id: ToggleId;
  before: SignalState;
  /** Only paths this apply may change, recorded before the first write. */
  paths: Set<string>;
}
interface ApplyFrame {
  baseline: Map<ToggleId, SignalState>;
  failures: Map<ToggleId, string>;
  expected: Map<ToggleId, boolean>;
  mutations: Mutation[];
  resetDone: boolean;
  writable?: Promise<void>;
}

/** Private to this injector: ownership survives applies, while every apply owns its own reset. */
class IntegrityStateInjector implements DeviceConditionInjector {
  readonly key = "integrityState";
  private readonly serialize = createSerializer();
  private readonly planted = new Set<string>();
  private readonly frames: ApplyFrame[] = [];
  private acquiredRoot = false;
  // The baseline of the latest changed apply or reset, including earlier touched signals. A controller
  // verifies after EACH newest-first reset, so this must follow that reset's baseline.
  private cleanBaseline = new Map<ToggleId, boolean>();

  constructor(
    private readonly adb: AdbExecutor,
    private readonly selinux: SelinuxOwner,
    private readonly artifacts: ArtifactOwner,
  ) {}

  /** A file signal's state without the stubs another fixture (rootState) still needs (#16275). */
  private async ownState(id: ToggleId, signal?: AbortSignal): Promise<SignalState> {
    const state = await this.readState(id, signal);
    if (id === "selinux-permissive") {
      return state;
    }
    const paths = new Set(
      [...state.paths].filter((path) => !this.artifacts.heldByOther(this, path)),
    );
    return { active: paths.size > 0, paths };
  }

  private async readState(id: ToggleId, signal?: AbortSignal): Promise<SignalState> {
    if (id !== "selinux-permissive") {
      const paths = await listExisting(this.adb, pathsFor(id), signal);
      return { active: paths.size > 0, paths };
    }
    const mode = await shell(this.adb, ["getenforce"], signal);
    if (!/^(Enforcing|Permissive)$/i.test(mode)) {
      throw new ActionableError(`integrityState cannot toggle SELinux mode '${mode}'`);
    }
    return { active: /^Permissive$/i.test(mode), paths: new Set() };
  }

  private async readActive(id: ToggleId, signal?: AbortSignal): Promise<boolean> {
    let failure: string | undefined;
    const adb = this.adb;
    // The catalogue probe is best effort for observation. Injection must fail closed if its
    // relevant sub-read fails, rather than interpreting an unreadable signal as inactive.
    const readings = await readIntegritySignals(
      {
        async execute(args, options) {
          const relevant = args[1] === (id === "selinux-permissive" ? "getenforce" : "ls");
          try {
            const result = await adb.execute(args, options);
            if (relevant && result.error) {
              failure = String(result.error);
            }
            if (
              relevant &&
              id === "selinux-permissive" &&
              !/^(Enforcing|Permissive)$/i.test(result.stdout.trim())
            ) {
              failure = `unreadable SELinux mode '${result.stdout.trim()}'`;
            }
            return result;
          } catch (error) {
            if (relevant) {
              failure = errorMessage(error);
            }
            throw toActionableError(error, "integrityState read-back failed");
          }
        },
      },
      signal,
    );
    if (failure) {
      throw new ActionableError(`integrityState read-back failed: ${failure}`);
    }
    return readings.find((reading) => reading.id === id)?.active === true;
  }

  private async root(signal?: AbortSignal, writable = false): Promise<void> {
    let wasRooted = true;
    try {
      wasRooted = (await shell(this.adb, ["id", "-u"], signal)) === "0";
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(
        `integrityState root probe failed; preserving existing privileges: ${errorMessage(error)}`,
        error,
      );
    }
    // Record before root: it may succeed even when the following transport wait fails.
    this.acquiredRoot ||= !wasRooted;
    await (writable ? remountWritable(this.adb, signal) : ensureRootAdb(this.adb, signal));
  }

  private async restorePrivileges(signal?: AbortSignal): Promise<void> {
    if (this.acquiredRoot) {
      await adbCommand(this.adb, ["unroot"], signal);
      this.acquiredRoot = false;
    }
  }

  private async restoreMutation(mutation: Mutation, signal?: AbortSignal): Promise<void> {
    if (mutation.id === "selinux-permissive") {
      if (this.selinux.changed(mutation)) {
        await this.root(signal);
      }
      await this.selinux.release(this.adb, mutation, signal, true);
    } else {
      await this.root(signal, true);
      // A stub another fixture still needs stays; that fixture's reset removes it (#16275).
      const remove = [...mutation.paths].filter(
        (path) => !mutation.before.paths.has(path) && this.artifacts.removableBy(this, path),
      );
      const replace = [...mutation.paths].filter((path) => mutation.before.paths.has(path));
      if (remove.length > 0) {
        await shell(this.adb, ["rm", "-f", ...remove], signal);
      }
      // Every replaced file was an inert stub owned by this injector before this apply.
      const existing = await listExisting(this.adb, replace, signal);
      await plantArtifacts(
        this.adb,
        replace.filter((path) => !existing.has(path)),
        new Set(),
        signal,
      );
    }
    const state = await this.ownState(mutation.id, signal);
    if (
      state.active !==
        (mutation.id === "selinux-permissive" ? this.selinux.expected : mutation.before.active) ||
      [...mutation.paths].some((path) => state.paths.has(path) !== mutation.before.paths.has(path))
    ) {
      throw new ActionableError(`integrityState reset did not restore ${mutation.id} read-back`);
    }
    for (const path of mutation.paths) {
      if (mutation.before.paths.has(path)) {
        this.planted.add(path);
        this.artifacts.plant(this, path);
      } else {
        this.planted.delete(path);
        this.artifacts.release(this, path);
      }
    }
  }

  private async resetFrame(frame: ApplyFrame, signal?: AbortSignal): Promise<void> {
    if (frame.resetDone) {
      return;
    }
    if (this.frames.at(-1) !== frame) {
      throw new ActionableError("integrityState reset must wait for the newer apply to restore");
    }
    this.cleanBaseline = frame.expected;
    for (const mutation of [...frame.mutations].reverse()) {
      await this.restoreMutation(mutation, signal);
      frame.mutations.splice(frame.mutations.indexOf(mutation), 1);
    }
    if (this.frames.length === 1) {
      await this.restorePrivileges(signal);
    }
    frame.resetDone = true;
    this.frames.pop();
  }

  private resetFor(frame: ApplyFrame): (signal?: AbortSignal) => Promise<void> {
    return (signal) => this.serialize(() => this.resetFrame(frame, signal));
  }

  private async captureFrame(
    ids: DeviceConditionSignalId[],
    signal?: AbortSignal,
  ): Promise<ApplyFrame> {
    const frame: ApplyFrame = {
      baseline: new Map(),
      failures: new Map(),
      expected: new Map(this.cleanBaseline),
      mutations: [],
      resetDone: false,
    };
    // Snapshot earlier touched signals too: after an intermediate reset the controller must
    // verify that intermediate snapshot, not the final baseline of an older outstanding reset.
    for (const id of new Set<DeviceConditionSignalId>([...ids, ...this.cleanBaseline.keys()])) {
      if (!isToggle(id)) {
        continue;
      }
      try {
        const state = await this.readState(id, signal);
        frame.baseline.set(id, state);
        frame.expected.set(id, state.active);
      } catch (error) {
        logger.warn(`integrityState baseline for ${id} failed: ${errorMessage(error)}`, error);
        frame.failures.set(id, errorMessage(error));
      }
    }
    return frame;
  }

  private async mutate(
    frame: ApplyFrame,
    mutation: Mutation,
    target: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (mutation.id === "selinux-permissive") {
      await this.selinux.capture(this.adb, mutation, signal);
      frame.mutations.push(mutation);
      await this.root(signal);
      await this.selinux.set(this.adb, mutation, target, signal);
      return;
    }
    // A remount failure affects the two file signals, but must not block SELinux.
    frame.writable ??= this.root(signal, true);
    await frame.writable;
    frame.mutations.push(mutation);
    if (target) {
      const paths = ROOT_ARTIFACT_PATHS.filter(
        (path) => pathsFor(mutation.id).includes(path) && !mutation.before.paths.has(path),
      );
      // Registered before the write, so a rollback after a half-planted file removes it.
      for (const path of paths) {
        this.artifacts.plant(this, path);
      }
      await plantArtifacts(this.adb, paths, mutation.paths, signal);
      for (const path of mutation.paths) {
        this.planted.add(path);
      }
    } else {
      for (const path of mutation.before.paths) {
        mutation.paths.add(path);
      }
      await shell(this.adb, ["rm", "-f", ...mutation.paths], signal);
      for (const path of mutation.paths) {
        this.planted.delete(path);
        this.artifacts.release(this, path);
      }
    }
  }

  private async rollback(frame: ApplyFrame, mutation: Mutation, error: unknown): Promise<void> {
    if (!frame.mutations.includes(mutation)) {
      return;
    }
    try {
      // Cancellation must not cancel cleanup of a write that may already have happened.
      await this.restoreMutation(mutation);
      frame.mutations.splice(frame.mutations.indexOf(mutation), 1);
    } catch (cleanupError) {
      logger.warn(`integrityState rollback failed: ${errorMessage(cleanupError)}`, cleanupError);
      this.cleanBaseline = frame.expected;
      this.frames.push(frame);
      throw new OwedResetError(
        `${errorMessage(error)} Cleanup also failed (${errorMessage(cleanupError)}); release will retry.`,
        this.resetFor(frame),
        { cause: error },
      );
    }
  }

  private async cancelFrame(frame: ApplyFrame, error: unknown): Promise<never> {
    if (frame.mutations.length > 0 || (this.frames.length === 0 && this.acquiredRoot)) {
      this.frames.push(frame);
      try {
        // An aborted request cannot cancel restoration of its already completed writes.
        await this.resetFrame(frame);
      } catch (cleanupError) {
        logger.warn(
          `integrityState cancellation cleanup failed: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
        throw new OwedResetError(
          `integrityState cancellation cleanup failed (${errorMessage(cleanupError)}); release will retry.`,
          this.resetFor(frame),
          { cause: error },
        );
      }
    }
    throw toActionableError(error, "integrityState apply aborted");
  }

  private shouldJoinSelinux(id: ToggleId): boolean {
    return (
      id === "selinux-permissive" &&
      this.selinux.owned &&
      !this.frames.some((prior) => prior.mutations.some((entry) => entry.id === id))
    );
  }

  private async applyToggle(
    frame: ApplyFrame,
    signalResult: DeviceConditionSignalResult,
    id: ToggleId,
    signal?: AbortSignal,
  ): Promise<void> {
    const before = frame.baseline.get(id);
    if (!before) {
      signalResult.detail = frame.failures.get(id);
      return;
    }
    const target = signalResult.requested === "on";
    // Off on a file not planted by this injector is unsupported with detail
    // "present on the image or planted by rootState; use rootState reset".
    if (
      !target &&
      id !== "selinux-permissive" &&
      [...before.paths].some(
        (path) => !this.planted.has(path) || this.artifacts.heldByOther(this, path),
      )
    ) {
      signalResult.detail = "present on the image or planted by rootState; use rootState reset";
      return;
    }
    const mutation: Mutation = { id, before, paths: new Set() };
    try {
      if (before.active !== target || this.shouldJoinSelinux(id)) {
        await this.mutate(frame, mutation, target, signal);
      }
      const active = await this.readActive(id, signal);
      if (active !== target) {
        throw new ActionableError(
          `integrityState ${id} read-back did not match ${signalResult.requested}`,
        );
      }
      signalResult.status = before.active === target ? "unchanged" : "applied";
      signalResult.active = active;
    } catch (error) {
      logger.warn(`integrityState ${id} failed: ${errorMessage(error)}`, error);
      signalResult.detail = errorMessage(error);
      await this.rollback(frame, mutation, error);
      if (signal?.aborted) {
        await this.cancelFrame(frame, error);
      }
    }
  }

  private async finishFrame(frame: ApplyFrame): Promise<void> {
    if (frame.mutations.length === 0 && this.frames.length === 0) {
      try {
        await this.restorePrivileges();
      } catch (error) {
        logger.warn(`integrityState privilege cleanup failed: ${errorMessage(error)}`, error);
        this.frames.push(frame);
        throw new OwedResetError(
          `integrityState privilege cleanup failed (${errorMessage(error)}); release will retry.`,
          this.resetFor(frame),
          { cause: error },
        );
      }
    }
    if (frame.mutations.length > 0) {
      this.cleanBaseline = frame.expected;
      this.frames.push(frame);
    }
  }

  private async applyRequest(
    request: DeviceConditionIntegrityParams,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> {
    const requested: DeviceConditionIntegrityParams["signals"] = {};
    if (request.preset) {
      for (const id of TOGGLE_IDS) {
        requested[id] = request.preset === "maximally-detectable" ? "on" : "off";
      }
    }
    Object.assign(requested, request.signals);
    const ids = Object.keys(requested) as DeviceConditionSignalId[];
    const frame = await this.captureFrame(ids, signal);
    const signals: DeviceConditionSignalResult[] = [];
    for (const id of ids) {
      const wanted = requested[id];
      if (!wanted) {
        continue;
      }
      const signalResult: DeviceConditionSignalResult = {
        id,
        requested: wanted,
        status: "unsupported",
      };
      signals.push(signalResult);
      if (isToggle(id)) {
        await this.applyToggle(frame, signalResult, id, signal);
      } else {
        signalResult.detail =
          id === "missing-otacerts"
            ? "needs root and writable /system and is not implemented yet"
            : "baked into the system image and only a different image changes it";
      }
    }
    await this.finishFrame(frame);
    return {
      status: signals.some((signalResult) => signalResult.status === "applied")
        ? "applied"
        : "unchanged",
      signals,
      ...(frame.mutations.length > 0 ? { reset: this.resetFor(frame) } : {}),
    };
  }

  async apply(
    value: string,
    signal?: AbortSignal,
    params?: Record<string, unknown>,
  ): Promise<DeviceConditionApplyOutcome> {
    let request: DeviceConditionIntegrityParams;
    if (value === DEVICE_CONDITION_APPLY) {
      const parsed = integrityStateParamsSchema().safeParse(params);
      if (!parsed.success) {
        throw new ActionableError(`Invalid integrityState parameters: ${parsed.error.message}`);
      }
      request = parsed.data;
    } else if (value === "maximally-detectable" || value === "minimally-detectable") {
      request = { preset: value };
    } else {
      rejectValue("integrityState", value, [
        "maximally-detectable",
        "minimally-detectable",
        "{ preset?, signals? }",
      ]);
    }
    return this.serialize(() => this.applyRequest(request, signal));
  }

  isClean(signal?: AbortSignal): Promise<boolean> {
    return this.serialize(async () => {
      // Root an older, still-applied frame needs is held on purpose (#16275). Once no frame has
      // mutations left to restore, root still acquired is owed cleanup.
      if (this.acquiredRoot && !this.frames.some((frame) => frame.mutations.length > 0)) {
        return false;
      }
      try {
        for (const [id, active] of this.cleanBaseline) {
          const clean =
            id === "selinux-permissive" && this.frames.length === 0
              ? await this.selinux.isClean(this.adb, signal)
              : (await this.ownState(id, signal)).active === active;
          if (!clean) {
            return false;
          }
        }
        return true;
      } catch (error) {
        logger.warn(`integrityState clean check failed: ${errorMessage(error)}`, error);
        return false;
      }
    });
  }
}

export function createIntegrityStateInjector(
  adb: AdbExecutor,
  selinux = new SelinuxOwner(),
  artifacts = new ArtifactOwner(),
): DeviceConditionInjector {
  return new IntegrityStateInjector(adb, selinux, artifacts);
}

const injectorsByDevice = new Map<string, DeviceConditionInjector>();

/** The Android integrity injector, cached per device so ownership survives successive applies. */
export function resolveIntegrityStateInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  options:
    | Map<string, DeviceConditionInjector>
    | {
        cache: Map<string, DeviceConditionInjector>;
        selinuxOwners?: Map<string, SelinuxOwner>;
        artifactOwners?: Map<string, ArtifactOwner>;
      } = injectorsByDevice,
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "integrityState") {
    return undefined;
  }
  const cache = options instanceof Map ? options : options.cache;
  const selinuxOwners = options instanceof Map ? selinuxOwnersByDevice : options.selinuxOwners;
  const artifactOwners = options instanceof Map ? artifactOwnersByDevice : options.artifactOwners;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createIntegrityStateInjector(
      adbFactory.create(device),
      resolveSelinuxOwner(device.deviceId, selinuxOwners),
      resolveArtifactOwner(device.deviceId, artifactOwners),
    );
    cache.set(device.deviceId, injector);
  }
  return injector;
}
