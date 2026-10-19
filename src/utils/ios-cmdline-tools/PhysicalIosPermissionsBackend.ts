import type { ExecResult } from "../../models";
import type { IosPermissionsBackend, IosPrivacyOperation } from "./IosPermissionsBackend";

export class PhysicalIosPermissionsBackend implements IosPermissionsBackend {
  readonly kind = "physical";

  async setPrivacy(
    _operation: IosPrivacyOperation,
  ): Promise<Pick<ExecResult, "stdout" | "stderr">> {
    // Actions retain their existing physical reset/query routing and reject this
    // simulator-only operation before it reaches a transport.
    throw new Error("iOS permission changes via simctl privacy are only supported on simulators");
  }
}
