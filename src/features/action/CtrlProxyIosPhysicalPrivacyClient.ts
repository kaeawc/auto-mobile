import { errorMessage } from "../../utils/describeUnknownError";
import type { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import type { IosPhysicalPrivacyClient } from "./IosPhysicalPermissions";
import type { IosSimulatorPermissionCommandResult } from "./IosSimulatorPermissions";

/**
 * Production {@link IosPhysicalPrivacyClient} backed by the CtrlProxy runner
 * WebSocket (port 8765). Sends one reset request per permission and adapts each
 * runner response into a per-permission result. When the runner is unreachable the
 * shared not-connected path yields a clear, actionable error on every permission.
 */
export class CtrlProxyIosPhysicalPrivacyClient implements IosPhysicalPrivacyClient {
  constructor(
    private readonly device: BootedDevice,
    private readonly getClient: () => IOSCtrlProxyClient = () =>
      IOSCtrlProxyClient.getInstance(this.device),
  ) {}

  async resetAuthorizations(
    appId: string,
    permissions: string[],
  ): Promise<IosSimulatorPermissionCommandResult[]> {
    const client = this.getClient();
    return Promise.all(
      permissions.map(async (permission) => {
        try {
          const response = await client.requestResetPermissions(appId, [permission]);
          return response.success
            ? { permission, success: true }
            : { permission, success: false, error: response.error ?? "Failed to reset permission" };
        } catch (error) {
          // Best-effort per-permission path: log the unexpected failure (so there is
          // a trace even though the message is also surfaced in the result) and
          // report it as a typed failure rather than aborting the whole batch.
          const message = errorMessage(error);
          logger.warn(
            `[IosPhysicalPermissions] reset of '${permission}' failed: ${message}`,
            error,
          );
          return { permission, success: false, error: message };
        }
      }),
    );
  }
}
