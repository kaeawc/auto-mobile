import type { ExecResult } from "../../models";
import type { IosDeviceBackend } from "./IosDeviceBackend";
import { resolveIosDeviceKind } from "./IosDeviceKind";

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
  const kind = resolveIosDeviceKind({ deviceId: options.deviceId });
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
