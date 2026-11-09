import type { Posture } from "../../models/DisplayPanel";

/** The two iPhone Duo panels whose activity reflects the hinge. */
export type IosHingePanelRole = "cover" | "inner";

/**
 * At or below this angle the cover layout is plausible: stepping 0 -> 90 keeps the app on the
 * cover panel with UIHinge.status closed. Above it the simulator should show the inner panel;
 * a cover layout there is the path-dependent "stuck" state (0 -> 80 -> 120 stays on cover, #17726).
 */
export const IOS_COVER_LAYOUT_MAX_DEGREES = 90;

/** Fully open; anything strictly between 0 and this with the inner panel active is half open. */
export const IOS_FULLY_OPEN_DEGREES = 180;

/**
 * Remembers the last hinge angle AutoMobile asked the runner to apply, per device. The runner
 * echoes the request and cannot read the app-visible angle, so this is never an observed angle.
 */
export interface IosRequestedHingeAngleStore {
  record(deviceId: string, degrees: number): void;
  requested(deviceId: string): number | undefined;
}

export class InMemoryIosRequestedHingeAngleStore implements IosRequestedHingeAngleStore {
  private readonly angles = new Map<string, number>();

  record(deviceId: string, degrees: number): void {
    this.angles.set(deviceId, degrees);
  }

  requested(deviceId: string): number | undefined {
    return this.angles.get(deviceId);
  }
}

/** Shared by setPosture (writer) and getDeviceState (reader) within one daemon process. */
export const defaultIosRequestedHingeAngleStore: IosRequestedHingeAngleStore =
  new InMemoryIosRequestedHingeAngleStore();

/**
 * Posture from the active panel, refined by the requested angle: cover is closed; inner is
 * half_opened strictly between 0 and 180 degrees, otherwise opened (also when no angle is known).
 */
export function iosPostureForPanel(role: IosHingePanelRole, requestedAngle?: number): Posture {
  if (role === "cover") {
    return "closed";
  }
  return requestedAngle !== undefined &&
    requestedAngle > 0 &&
    requestedAngle < IOS_FULLY_OPEN_DEGREES
    ? "half_opened"
    : "opened";
}

/** A warning with a next step when the active panel contradicts the requested hinge angle. */
export function iosHingeLayoutWarning(
  requestedAngle: number,
  role: IosHingePanelRole,
): string | undefined {
  if (role === "cover" && requestedAngle > IOS_COVER_LAYOUT_MAX_DEGREES) {
    return (
      `Hinge and layout disagree: requested ${requestedAngle} degrees, but the cover panel is still active, so apps show the closed (cover) layout. ` +
      "The iPhone Duo simulator's panel switch depends on the angles it passed through (for example 0 -> 80 -> 120 stays on the cover panel). " +
      `Call setPosture with hingeAngle ${IOS_FULLY_OPEN_DEGREES}, then the target angle again, and observe before acting.`
    );
  }
  if (role === "inner" && requestedAngle <= 0) {
    return (
      `Hinge and layout disagree: requested ${requestedAngle} degrees (closed), but the inner panel is still active. ` +
      'Call setPosture with posture "closed" and observe before acting.'
    );
  }
  return undefined;
}
