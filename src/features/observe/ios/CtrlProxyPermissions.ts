/**
 * CtrlProxy iOS Permissions - Delegate for app privacy permission operations.
 *
 * Handles resetting iOS privacy authorizations (camera/photos/etc.) on physical
 * devices via the CtrlProxy XCUITest runner, which calls
 * `XCUIApplication.resetAuthorizationStatus(for:)`. See issue #2491.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { DelegateContext, CtrlProxyResetPermissionsResult } from "./types";
import { sendCommand } from "../DeviceServiceUtils";

/**
 * Delegate class for app privacy permission operations.
 */
export class CtrlProxyPermissions {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * Reset the given privacy resources for an app back to not-determined.
   *
   * The runner maps each AutoMobile permission name to an `XCUIProtectedResource`
   * and resets it; an unmapped resource (e.g. `siri`) comes back as a structured
   * failure. When the runner is unreachable the shared not-connected path surfaces a
   * clear, actionable message rather than an opaque socket timeout.
   */
  async requestResetPermissions(
    bundleId: string,
    permissions: string[],
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyResetPermissionsResult> {
    return sendCommand<CtrlProxyResetPermissionsResult>(this.context, {
      idPrefix: "resetPermissions",
      responseType: "reset_permissions_result",
      messageType: "request_reset_permissions",
      params: { bundleId, permissions },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      notConnectedMessage:
        "iOS permission reset requires the CtrlProxy runner to be active on the device (port 8765)",
      errorLabel: "Reset permissions",
    });
  }
}
