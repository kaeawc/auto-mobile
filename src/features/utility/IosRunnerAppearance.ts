import type { DisplayTheme } from "./displayConfigTypes";
import type { CtrlProxyAppearanceResult } from "../observe/ios/types";

/** The runner's `request_appearance` (`XCUIDevice.appearance`); physical iOS has no simctl. */
export interface IosRunnerAppearanceClient {
  requestAppearance(appearance?: "light" | "dark"): Promise<CtrlProxyAppearanceResult>;
}

/** Reads and writes a physical iOS device's light/dark appearance through the CtrlProxy runner. */
export interface IosAppearanceBackend {
  /** Names the target in errors. */
  readonly target: string;
  read(): Promise<DisplayTheme | undefined>;
  /** Resolves on success; rejects with the backend's own error. */
  write(theme: "light" | "dark"): Promise<void>;
}

/** Physical iOS appearance through the runner (#14092); the Simulator uses simctl instead. */
export function iosRunnerAppearanceBackend(
  runner: IosRunnerAppearanceClient,
): IosAppearanceBackend {
  const call = async (appearance?: "light" | "dark") => {
    const result = await runner.requestAppearance(appearance);
    if (!result.success) {
      throw new Error(
        `CtrlProxy runner appearance request failed: ${result.error ?? "unknown error"}. ` +
          "Physical-device theme control needs a runner that supports request_appearance.",
      );
    }
    return result.appearance === "light" || result.appearance === "dark"
      ? result.appearance
      : undefined;
  };
  return {
    target: "device",
    read: () => call(),
    write: async (theme) => {
      await call(theme);
    },
  };
}
