import { toActionableError } from "../../models/ActionableError";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../HostCommandExecutor";

export { AXBridgePreflightError } from "./AXBridgePreflightError";

export interface AXBridgePreflight {
  isAquaSession(): Promise<boolean>;
  isAccessibilityTrusted(): boolean;
}

/** Checks the caller's trust without prompting or launching the companion. */
export class DefaultAXBridgePreflight implements AXBridgePreflight {
  constructor(
    private readonly commands: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async isAquaSession(): Promise<boolean> {
    if (this.platform !== "darwin") {
      return false;
    }
    try {
      const result = await this.commands.executeCommand("/bin/launchctl", ["managername"], {
        timeoutMs: 5000,
      });
      return result.stdout.trim() === "Aqua";
    } catch (error) {
      throw toActionableError(
        error,
        "Could not check the Aqua session; run the daemon from a macOS desktop login",
      );
    }
  }

  isAccessibilityTrusted(): boolean {
    try {
      const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
      const library = dlopen(
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
        {
          AXIsProcessTrusted: { args: [], returns: FFIType.bool },
        },
      );
      try {
        return library.symbols.AXIsProcessTrusted();
      } finally {
        library.close();
      }
    } catch (error) {
      throw toActionableError(
        error,
        "Could not check Accessibility trust; run the daemon with Bun on macOS",
      );
    }
  }
}
