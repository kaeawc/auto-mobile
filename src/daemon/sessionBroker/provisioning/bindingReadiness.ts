import type { BindingPlatform } from "../registry/bindingRegistry";
import type { BindingProvisionedDevice } from "./reconcilerContracts";

/**
 * The readiness provisionDevice reports for an Apple Watch simulator it booted and bound a session
 * to: the `booted` level (owner decision, #15882). A watch has no automation runner, so this is
 * the most a watch binding can reach.
 */
export const WATCH_BOOTED_READINESS = { mode: "none", status: "device_ready" } as const;

/**
 * Whether a provisioned binding device may be published. Android and iOS bindings require the
 * automation runner (`automation` / `automation_ready`); a watch binding is ready once booted with
 * a session bound. Every platform needs a session.
 */
export function isBindingReady(
  platform: BindingPlatform,
  provisioned: Pick<BindingProvisionedDevice, "sessionUuid" | "readiness">,
): boolean {
  if (provisioned.sessionUuid.length === 0) {
    return false;
  }
  const { mode, status } = provisioned.readiness;
  return platform === "watchos"
    ? mode === WATCH_BOOTED_READINESS.mode && status === WATCH_BOOTED_READINESS.status
    : mode === "automation" && status === "automation_ready";
}

/** What a device that failed {@link isBindingReady} did not reach, for the refusal message. */
export function bindingReadinessLabel(platform: BindingPlatform): string {
  return platform === "watchos" ? "a booted, session-bound state" : "automation readiness";
}
