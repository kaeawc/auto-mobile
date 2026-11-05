import type { BootedDevice, ExecResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import {
  SimulatorTccSqliteClient,
  tccServiceForPermission,
  type TccPermissionReader,
  type TccPermissionRow,
} from "../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { SimctlStatusBarController } from "../utility/SimctlStatusBarController";
import type { StatusBarOverrides } from "../utility/StatusBarOverride";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import {
  DEVICE_CONDITION_APPLY,
  deviceLocationParamsSchema,
  privacyParamsSchema,
  statusBarParamsSchema,
  type DeviceConditionKey,
  type DeviceConditionPrivacyTarget,
} from "./DeviceConditionTypes";
import { rejectValue } from "./injectorSupport";

/**
 * Platform-neutral `statusBar`, `privacy` and `location` conditions (#14073), implemented on the
 * iOS Simulator with `simctl`. Each apply registers the reset that undoes it; release, rebind,
 * lease expiry or reset runs them newest first. A physical iOS device has no simctl, and Android
 * has no injector for these keys yet, so both refuse with text naming the supported target.
 */

export const SHARED_CONDITION_KEYS = ["statusBar", "privacy", "location"] as const;
export type SharedConditionKey = (typeof SHARED_CONDITION_KEYS)[number];

const SIMCTL_CONDITION_TIMEOUT_MS = 10_000;

export type SimctlConditionRunner = Pick<SimCtl, "executeCommandArgs">;

export interface IosSimulatorConditionDeps {
  simctlFactory?: (device: BootedDevice) => SimctlConditionRunner;
  privacyReader?: TccPermissionReader;
  isSimulator?: (device: BootedDevice) => boolean;
  /** Owed privacy baselines per device id; the resolver runs on every apply, so they live here. */
  privacyBaselines?: Map<string, PrivacyBaselineStore>;
}

function isSharedConditionKey(key: DeviceConditionKey): key is SharedConditionKey {
  return (SHARED_CONDITION_KEYS as readonly string[]).includes(key);
}

function refusal(key: DeviceConditionKey, message: string): DeviceConditionInjector {
  return {
    key,
    apply: () => Promise.reject(new ActionableError(message)),
    isClean: () => Promise.resolve(true),
  };
}

async function runSimctl(
  simctl: SimctlConditionRunner,
  args: string[],
  signal?: AbortSignal,
): Promise<ExecResult> {
  const result = await simctl.executeCommandArgs(args, SIMCTL_CONDITION_TIMEOUT_MS, signal);
  if (result.error) {
    throw new ActionableError(`simctl ${args.join(" ")} failed: ${result.error}`);
  }
  return result;
}

function requireApply(key: DeviceConditionKey, value: string): void {
  if (value !== DEVICE_CONDITION_APPLY) {
    rejectValue(key, value, [DEVICE_CONDITION_APPLY]);
  }
}

function parseParams<T>(
  key: DeviceConditionKey,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  params: Record<string, unknown> | undefined,
): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new ActionableError(`Invalid ${key} parameters.`);
  }
  return parsed.data;
}

/** `statusBar`: `simctl status_bar override`, cleared with `simctl status_bar clear`. */
export function createSimulatorStatusBarInjector(
  device: BootedDevice,
  simctl: SimctlConditionRunner,
): DeviceConditionInjector {
  const controller = new SimctlStatusBarController(device, simctl);
  return {
    key: "statusBar",
    async apply(value, signal, params): Promise<DeviceConditionApplyOutcome> {
      requireApply("statusBar", value);
      const overrides: StatusBarOverrides = parseParams(
        "statusBar",
        statusBarParamsSchema(),
        params,
      );
      const { applied } = await controller.override(overrides, signal);
      return {
        status: "applied",
        detail: `status bar overrides: ${applied.join(", ")}`,
        reset: (s) => controller.clear(s),
      };
    },
    // simctl has no structured readback; a clear that exited cleanly is the verification.
    isClean: () => Promise.resolve(true),
  };
}

/** `location`: `simctl location set`, cleared with `simctl location clear`. */
export function createSimulatorLocationInjector(
  device: BootedDevice,
  simctl: SimctlConditionRunner,
): DeviceConditionInjector {
  return {
    key: "location",
    async apply(value, signal, params): Promise<DeviceConditionApplyOutcome> {
      requireApply("location", value);
      const { latitude, longitude } = parseParams("location", deviceLocationParamsSchema(), params);
      await runSimctl(
        simctl,
        ["location", device.deviceId, "set", `${latitude},${longitude}`],
        signal,
      );
      return {
        status: "applied",
        detail: `simulated location set to ${latitude},${longitude}`,
        reset: async (s) => {
          await runSimctl(simctl, ["location", device.deviceId, "clear"], s);
        },
      };
    },
    // simctl cannot read the simulated location back; a clear that exited cleanly is the verification.
    isClean: () => Promise.resolve(true),
  };
}

/** The stored decision for one privacy service, as the simctl action that recreates it. */
type PrivacyDecision = "grant" | "revoke" | "reset";
type PrivacyService = DeviceConditionPrivacyTarget["service"];

/**
 * Services whose stored decisions move together, in restore order. Revoking `photos` also denies
 * `photos-add` (iOS 26.5 captures), and granting `photos` back leaves `photos-add` denied, so a
 * change to either is restored as the whole group.
 */
const PRIVACY_SERVICE_GROUPS: readonly (readonly PrivacyService[])[] = [
  ["photos", "photos-add"],
  ["location", "location-always"],
];

function privacyGroup(service: PrivacyService): readonly PrivacyService[] {
  return PRIVACY_SERVICE_GROUPS.find((group) => group.includes(service)) ?? [service];
}

function decisionFromRow(row: TccPermissionRow | undefined): PrivacyDecision | undefined {
  if (row === undefined) {
    return "reset";
  }
  const authValue = row.auth_value ?? null;
  if (authValue !== null) {
    return authValue === 2 ? "grant" : authValue === 0 ? "revoke" : undefined;
  }
  // Legacy TCC schema stores `allowed` (0/1) instead of `auth_value`.
  return row.allowed === 1 ? "grant" : row.allowed === 0 ? "revoke" : undefined;
}

type PrivacySnapshot = Map<PrivacyService, PrivacyDecision | undefined>;

/** Reads one app's decisions for a set of services; a decision simctl cannot recreate is undefined. */
function privacySnapshotReader(reader: TccPermissionReader, device: BootedDevice) {
  return async (
    appId: string,
    services: readonly PrivacyService[],
    signal?: AbortSignal,
  ): Promise<PrivacySnapshot> => {
    const rows = await reader.readPermissions(device.deviceId, appId, [...services], signal);
    return new Map(
      services.map((service) => {
        const tccService = tccServiceForPermission(service);
        return [service, decisionFromRow(rows.find((row) => row.service === tccService))];
      }),
    );
  };
}

/**
 * The original decisions of one app's service group, shared by every apply that changed the group
 * until a reset restores it and reads it back. Later applies reuse it instead of capturing their own
 * intermediate state, so retrying an older reset can never reinstate a fixture.
 */
interface PrivacyBaseline {
  decisions: PrivacySnapshot;
  /** Set once a reset restored and read back the baseline; every other reset is then a no-op. */
  retired?: true;
}

/** Original privacy baselines still owed, per app and service group. */
export type PrivacyBaselineStore = Map<string, PrivacyBaseline>;

/**
 * `privacy`: `simctl privacy grant|revoke` for one app and service. The original stored decisions
 * of the service's group are read first so reset puts back exactly those decisions (grant, revoke,
 * or no decision); an original decision simctl cannot recreate, such as limited Photos access, is
 * refused before any change.
 */
export function createSimulatorPrivacyInjector(
  device: BootedDevice,
  simctl: SimctlConditionRunner,
  reader: TccPermissionReader,
  baselines: PrivacyBaselineStore = new Map(),
): DeviceConditionInjector {
  const readPrivacySnapshot = privacySnapshotReader(reader, device);
  /**
   * Restore in group order, re-reading before each step because one service's change can move
   * another, then read the group back. Only a matching read-back retires the baseline; a mismatch
   * throws so the reset stays owed and a later restore retries it.
   */
  const restore = async (
    appId: string,
    group: readonly PrivacyService[],
    baseline: PrivacyBaseline,
    signal?: AbortSignal,
  ): Promise<void> => {
    for (const service of group) {
      const wanted = baseline.decisions.get(service);
      const current = await readPrivacySnapshot(appId, [service], signal);
      if (wanted !== undefined && current.get(service) !== wanted) {
        await runSimctl(simctl, ["privacy", device.deviceId, wanted, service, appId], signal);
      }
    }
    const after = await readPrivacySnapshot(appId, group, signal);
    const mismatched = group.filter(
      (service) => after.get(service) !== baseline.decisions.get(service),
    );
    if (mismatched.length > 0) {
      throw new ActionableError(
        `privacy restore for ${appId} did not read back the original '${mismatched.join("', '")}' decision; it will be retried on the next reset or release.`,
      );
    }
    baseline.retired = true;
  };
  return {
    key: "privacy",
    async apply(value, signal, params): Promise<DeviceConditionApplyOutcome> {
      requireApply("privacy", value);
      const target = parseParams("privacy", privacyParamsSchema(), params);
      const group = privacyGroup(target.service);
      const storeKey = `${target.appId}\u0000${group[0]}`;
      const current = await readPrivacySnapshot(target.appId, group, signal);
      const owed = baselines.get(storeKey);
      const baseline: PrivacyBaseline = owed ?? { decisions: current };
      const unrestorable = group.filter((service) => baseline.decisions.get(service) === undefined);
      if (unrestorable.length > 0) {
        throw new ActionableError(
          `The existing '${unrestorable.join("', '")}' decision for ${target.appId} cannot be restored by simctl (for example limited access), so it was left unchanged. Reset the app's privacy settings first.`,
        );
      }
      if (current.get(target.service) === target.action) {
        return {
          status: "unchanged",
          detail: `'${target.service}' for ${target.appId} already has the '${target.action}' decision`,
        };
      }
      baselines.set(storeKey, baseline);
      try {
        await runSimctl(
          simctl,
          ["privacy", device.deviceId, target.action, target.service, target.appId],
          signal,
        );
      } catch (error) {
        // No reset owns a baseline this failed apply created; an earlier apply's baseline stays.
        if (owed === undefined) {
          baselines.delete(storeKey);
        }
        throw error;
      }
      const original = group.map((service) => `${service}=${baseline.decisions.get(service)}`);
      return {
        status: "applied",
        detail: `${target.action} '${target.service}' for ${target.appId}; reset restores ${original.join(", ")}`,
        reset: async (s) => {
          if (baseline.retired !== true) {
            await restore(target.appId, group, baseline, s);
          }
          if (baselines.get(storeKey) === baseline) {
            baselines.delete(storeKey);
          }
        },
        // restore() read the group back before retiring the baseline, for this reset or another.
        isClean: () => Promise.resolve(baseline.retired === true),
      };
    },
    isClean: () => Promise.resolve(true),
  };
}

/** Baselines shared across resolves without injected state, per device id. */
const defaultPrivacyBaselines = new Map<string, PrivacyBaselineStore>();

function privacyBaselinesFor(
  deps: IosSimulatorConditionDeps,
  device: BootedDevice,
): PrivacyBaselineStore {
  const perDevice = deps.privacyBaselines ?? defaultPrivacyBaselines;
  let store = perDevice.get(device.deviceId);
  if (store === undefined) {
    store = new Map();
    perDevice.set(device.deviceId, store);
  }
  return store;
}

/**
 * The injector for a shared key on this device: a simctl injector on an iOS Simulator, a refusal
 * on a physical iOS device or Android. Returns undefined for any other key.
 */
export function resolveIosSimulatorConditionInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: IosSimulatorConditionDeps = {},
): DeviceConditionInjector | undefined {
  if (!isSharedConditionKey(key)) {
    return undefined;
  }
  if (device.platform !== "ios") {
    return refusal(
      key,
      `unsupported on ${device.platform}: '${key}' is implemented on the iOS Simulator only so far. Use an iOS Simulator.`,
    );
  }
  const isSimulator =
    deps.isSimulator ??
    ((target: BootedDevice) => resolveIosDeviceKind({ deviceId: target.deviceId }) === "simulator");
  if (!isSimulator(device)) {
    return refusal(
      key,
      `unsupported on a physical iOS device: '${key}' uses simctl, which drives only the iOS Simulator. Use an iOS Simulator.`,
    );
  }
  const simctl = (deps.simctlFactory ?? ((target) => new SimCtlClient(target)))(device);
  switch (key) {
    case "statusBar":
      return createSimulatorStatusBarInjector(device, simctl);
    case "location":
      return createSimulatorLocationInjector(device, simctl);
    case "privacy":
      return createSimulatorPrivacyInjector(
        device,
        simctl,
        deps.privacyReader ?? new SimulatorTccSqliteClient(),
        privacyBaselinesFor(deps, device),
      );
  }
}
