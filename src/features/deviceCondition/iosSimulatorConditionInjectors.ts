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

async function readPrivacyDecision(
  reader: TccPermissionReader,
  device: BootedDevice,
  target: DeviceConditionPrivacyTarget,
  signal?: AbortSignal,
): Promise<PrivacyDecision | undefined> {
  const service = tccServiceForPermission(target.service);
  const rows = await reader.readPermissions(
    device.deviceId,
    target.appId,
    [target.service],
    signal,
  );
  return decisionFromRow(rows.find((row) => row.service === service));
}

/**
 * `privacy`: `simctl privacy grant|revoke` for one app and service. The prior stored decision is
 * read first so reset puts back exactly that decision (grant, revoke, or no decision); a prior
 * decision simctl cannot recreate, such as limited Photos access, is refused before any change.
 */
export function createSimulatorPrivacyInjector(
  device: BootedDevice,
  simctl: SimctlConditionRunner,
  reader: TccPermissionReader,
): DeviceConditionInjector {
  return {
    key: "privacy",
    async apply(value, signal, params): Promise<DeviceConditionApplyOutcome> {
      requireApply("privacy", value);
      const target = parseParams("privacy", privacyParamsSchema(), params);
      const prior = await readPrivacyDecision(reader, device, target, signal);
      if (prior === undefined) {
        throw new ActionableError(
          `The existing '${target.service}' decision for ${target.appId} cannot be restored by simctl (for example limited access), so it was left unchanged. Reset the app's privacy settings first.`,
        );
      }
      if (prior === target.action) {
        return {
          status: "unchanged",
          detail: `'${target.service}' for ${target.appId} already has the '${prior}' decision`,
        };
      }
      await runSimctl(
        simctl,
        ["privacy", device.deviceId, target.action, target.service, target.appId],
        signal,
      );
      return {
        status: "applied",
        detail: `${target.action} '${target.service}' for ${target.appId}; reset restores '${prior}'`,
        reset: async (s) => {
          await runSimctl(
            simctl,
            ["privacy", device.deviceId, prior, target.service, target.appId],
            s,
          );
        },
        isClean: async (s) => (await readPrivacyDecision(reader, device, target, s)) === prior,
      };
    },
    isClean: () => Promise.resolve(true),
  };
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
      );
  }
}
