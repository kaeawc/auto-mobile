import type { ExecResult } from "../../models";
import { resolveIosDeviceBackend, type IosDeviceBackend } from "./IosDeviceBackend";

/** Resolve kind only; neither uninstall transport is reachable through this seam. */
export function resolveIosDeviceKind(options: { deviceId: string }): IosDeviceBackend["kind"] {
  return resolveIosDeviceBackend(options.deviceId, {
    simctl: {
      terminateApp: async () => {
        throw new Error("Kind resolution cannot terminate apps");
      },
    },
    deviceAppUninstaller: {
      uninstallApp: async () => {
        throw new Error("Kind resolution cannot uninstall apps");
      },
    },
  }).kind;
}

export interface IosKeychainControlClient {
  executeCommandArgs(args: string[], timeoutMs?: number): Promise<ExecResult>;
}

export interface IosKeychainControlBackend {
  readonly kind: IosDeviceBackend["kind"];
  resetKeychain(): Promise<void>;
}

export function resolveIosKeychainControlBackend(options: {
  deviceId: string;
  simctl: IosKeychainControlClient;
}): IosKeychainControlBackend {
  const kind = resolveIosDeviceKind(options);
  if (kind === "physical") {
    return {
      kind,
      resetKeychain: async () => {
        // Actions reject physical devices before confirmation or transport execution.
        throw new Error("Keychain reset is not supported on physical iOS devices");
      },
    };
  }
  return {
    kind,
    resetKeychain: async () => {
      await options.simctl.executeCommandArgs(["keychain", options.deviceId, "reset"]);
    },
  };
}
