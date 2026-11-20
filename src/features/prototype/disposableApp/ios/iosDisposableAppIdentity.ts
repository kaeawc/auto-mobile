import { createHash } from "node:crypto";
import { ActionableError } from "../../../../models/ActionableError";
import { resolveIosDeviceKind } from "../../../../utils/ios-cmdline-tools/IosDeviceKind";

export const IOS_DISPOSABLE_APP_SIGNER = createHash("sha256").update("adhoc").digest("hex");
export const IOS_DISPOSABLE_APP_SPEC = "prototype.json";

export function requireDisposableAppSimulator(deviceId: string): void {
  if (resolveIosDeviceKind({ deviceId }) !== "simulator") {
    throw new ActionableError(
      "iOS disposable prototype apps require a simulator. Use ProtoViewer on a physical iPhone.",
    );
  }
}
