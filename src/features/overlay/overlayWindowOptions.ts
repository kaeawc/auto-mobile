import { CTRL_PROXY_PACKAGE } from "../../ctrlProxy/constants";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { OVERLAY_WINDOW_OPTIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import type { OverlaySpec } from "./overlaySpec";

/** Window options that change behaviour away from the defaults, and so need device support. */
export interface RequestedOverlayWindowOptions {
  /** `window.layer: "app"` (#10496): needs SYSTEM_ALERT_WINDOW for the CtrlProxy package. */
  appLayer: boolean;
  /** `window.persistence: "device"` (#10494): outlives the session and the idle timeout. */
  devicePersistence: boolean;
}

export function requestedOverlayWindowOptions(spec: OverlaySpec): RequestedOverlayWindowOptions {
  return {
    appLayer: spec.window.layer === "app",
    devicePersistence: spec.window.persistence === "device",
  };
}

export function overlayWindowOptionsUnsupportedMessage(
  options: RequestedOverlayWindowOptions,
): string {
  const fields = [
    ...(options.appLayer ? ['window.layer "app"'] : []),
    ...(options.devicePersistence ? ['window.persistence "device"'] : []),
  ].join(" and ");
  return `The connected CtrlProxy does not advertise ${OVERLAY_WINDOW_OPTIONS_CAPABILITY}, so it would ignore ${fields} and show a session-scoped system-layer overlay; update the connected CtrlProxy or omit ${fields}.`;
}

/** The appop that lets CtrlProxy add `TYPE_APPLICATION_OVERLAY` windows without a prompt. */
export const OVERLAY_APP_LAYER_APPOP_COMMAND = `shell appops set ${CTRL_PROXY_PACKAGE} SYSTEM_ALERT_WINDOW allow`;

/**
 * Grants SYSTEM_ALERT_WINDOW to CtrlProxy before an app-layer overlay is sent. Best effort: when
 * the grant fails the device refuses the show itself with the command to run, so the failure is
 * logged rather than thrown and the request still goes out. Cancellation is not a grant failure:
 * an aborted [signal] is rethrown so a cancelled request never goes on to show the overlay.
 */
export async function grantOverlayAppLayer(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await adb.executeCommand(
      OVERLAY_APP_LAYER_APPOP_COMMAND,
      undefined,
      undefined,
      true,
      signal,
    );
    if (outputLooksLikeShellFailure(result.stdout, result.stderr ?? "")) {
      logger.warn(
        `[overlay] SYSTEM_ALERT_WINDOW appop grant reported a failure: ${`${result.stdout}\n${result.stderr ?? ""}`.trim()}`,
      );
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.warn(`[overlay] SYSTEM_ALERT_WINDOW appop grant failed: ${errorMessage(error)}`, error);
  }
}
