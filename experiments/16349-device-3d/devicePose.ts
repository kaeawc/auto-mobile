/**
 * THROWAWAY research prototype for #16349. Not for merge.
 *
 * Pure pose rules for a CSS-3D device view. Postures and hinge angles use the `setPosture`
 * vocabulary (src/models/DisplayPanel.ts): a hinge angle of 180 is flat, 0 is shut.
 */

export type Posture3d = "closed" | "half_opened" | "opened" | "flipped" | "tent" | "rear_display";

/**
 * The hinge angle the web model draws for each posture. `setPosture`'s `hingeAngle` is 0-180,
 * so `tent` and `flipped` (folded backwards past flat) cannot be reached through it; the web
 * model draws them at an angle above 180 instead.
 */
export const POSTURE_HINGE_DEGREES: Readonly<Record<Posture3d, number>> = {
  closed: 0,
  half_opened: 90,
  opened: 180,
  tent: 290,
  flipped: 360,
  rear_display: 360,
};

export interface Orbit {
  /** Rotation about the vertical axis, degrees. */
  readonly yaw: number;
  /** Rotation about the horizontal axis, degrees. */
  readonly pitch: number;
}

/** The flat 2D frame: no orbit, no fold. Switching to 2D animates back to this pose. */
export const FLAT_ORBIT: Orbit = { yaw: 0, pitch: 0 };
/** The pose 3D opens at: a three-quarter view. */
export const DEFAULT_3D_ORBIT: Orbit = { yaw: 30, pitch: 14 };

export function clampOrbit(orbit: Orbit): Orbit {
  return {
    yaw: ((((orbit.yaw + 180) % 360) + 360) % 360) - 180,
    pitch: Math.max(-80, Math.min(80, orbit.pitch)),
  };
}

export function clampHinge(degrees: number): number {
  return Math.max(0, Math.min(360, degrees));
}

export interface DevicePose {
  /** Transform of the whole device, about its centre. */
  readonly device: string;
  /** Transform of the moving leaf, about the hinge line. */
  readonly leaf: string;
}

/**
 * The CSS transforms for one pose. `axis` is the hinge axis on screen: `vertical` folds a book
 * foldable left-right, `horizontal` folds a flip top-bottom. The fixed leaf is the left (or top)
 * half; the moving leaf turns by `180 - hinge` degrees about the hinge line.
 */
export function devicePose(
  orbit: Orbit,
  hingeDegrees: number,
  axis: "vertical" | "horizontal",
): DevicePose {
  // Self-contained (no calls to sibling helpers): the page inlines this function's toString().
  const yaw = ((((orbit.yaw + 180) % 360) + 360) % 360) - 180;
  const pitch = Math.max(-80, Math.min(80, orbit.pitch));
  const turn = 180 - Math.max(0, Math.min(360, hingeDegrees));
  const leaf = axis === "vertical" ? `rotateY(${-turn}deg)` : `rotateX(${turn}deg)`;
  return {
    device: `rotateX(${-pitch}deg) rotateY(${yaw}deg)`,
    leaf,
  };
}

/**
 * The posture whose pre-rendered panel layout the screen shows at a hinge angle, for reflow during
 * a fold. Below `closedBelow` the device is shut (cover panel), above `flatAbove` it is flat, and
 * between them half-opened. The thresholds are per-device configuration on a real device; these
 * defaults are placeholders the frame registry would carry.
 */
export function postureAtHinge(
  degrees: number,
  thresholds: { closedBelow: number; flatAbove: number } = { closedBelow: 20, flatAbove: 160 },
): "closed" | "half_opened" | "opened" {
  const angle = Math.max(0, Math.min(360, degrees));
  if (angle < thresholds.closedBelow) {
    return "closed";
  }
  return angle > thresholds.flatAbove ? "opened" : "half_opened";
}
