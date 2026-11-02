import { z } from "zod";
import { ActionableError } from "../../../models";
import registry from "./deviceFrames.json";

/**
 * Device frames for the prototype web renderer (#16346): data-only screen geometry, so adding a
 * device is one JSON entry. Named "frame" so it never reads as the session broker's OEM
 * deviceProfile (#14058).
 */
const dp = () => z.number().finite().min(0).max(4096);
const insets = () => z.object({ top: dp(), bottom: dp(), left: dp(), right: dp() }).strict();

const cutoutSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({ type: z.literal("punchHole"), centerXDp: dp(), centerYDp: dp(), radiusDp: dp() })
    .strict(),
  z
    .object({
      type: z.enum(["notch", "island"]),
      centerXDp: dp(),
      centerYDp: dp(),
      widthDp: dp(),
      heightDp: dp(),
    })
    .strict(),
]);

const deviceFrameSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    platform: z.enum(["android", "ios"]),
    label: z.string().min(1).max(64),
    screen: z
      .object({
        widthDp: dp().positive(),
        heightDp: dp().positive(),
        density: z.number().positive().max(8),
      })
      .strict(),
    cornerRadiusDp: dp(),
    cutout: cutoutSchema,
    statusBarDp: dp(),
    navBar: z.discriminatedUnion("type", [
      z.object({ type: z.literal("none") }).strict(),
      z.object({ type: z.enum(["gesture", "buttons"]), heightDp: dp() }).strict(),
    ]),
    safeArea: z.object({ portrait: insets(), landscape: insets() }).strict(),
    frame: z.object({ bezelDp: dp(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict(),
    /** Where the geometry came from, per entry, so unmeasured values stay visible. */
    source: z.object({ screen: z.string().min(1), insets: z.string().min(1) }).strict(),
  })
  .strict();

const registrySchema = z.object({ frames: z.array(deviceFrameSchema).min(1) }).strict();

export type DeviceFrame = z.output<typeof deviceFrameSchema>;
type Insets = DeviceFrame["safeArea"]["portrait"];

export function parseDeviceFrames(value: unknown) {
  return registrySchema.safeParse(value);
}

function cutoutOutsideScreen(frame: DeviceFrame): boolean {
  const { cutout, screen } = frame;
  if (cutout.type === "none") {
    return false;
  }
  const [halfWidth, halfHeight] =
    cutout.type === "punchHole"
      ? [cutout.radiusDp, cutout.radiusDp]
      : [cutout.widthDp / 2, cutout.heightDp / 2];
  return (
    cutout.centerXDp - halfWidth < 0 ||
    cutout.centerXDp + halfWidth > screen.widthDp ||
    cutout.centerYDp - halfHeight < 0 ||
    cutout.centerYDp + halfHeight > screen.heightDp
  );
}

function leavesNoScreen(inset: Insets, width: number, height: number): boolean {
  return inset.left + inset.right >= width || inset.top + inset.bottom >= height;
}

function frameProblems(frame: DeviceFrame, path: string): string[] {
  const { widthDp, heightDp } = frame.screen;
  return [
    cutoutOutsideScreen(frame) ? `${path}.cutout: lies outside the portrait screen` : undefined,
    leavesNoScreen(frame.safeArea.portrait, widthDp, heightDp)
      ? `${path}.safeArea.portrait: insets leave no screen`
      : undefined,
    leavesNoScreen(frame.safeArea.landscape, heightDp, widthDp)
      ? `${path}.safeArea.landscape: insets leave no screen`
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
}

/** Every reason a registry is unusable; empty when it is valid. */
export function deviceFrameProblems(value: unknown): string[] {
  const parsed = parseDeviceFrames(value);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  }
  const seen = new Set<string>();
  return parsed.data.frames.flatMap((frame, index) => {
    const path = `frames[${index}]`;
    const duplicate = seen.has(frame.id) ? [`${path}.id: duplicate id "${frame.id}"`] : [];
    seen.add(frame.id);
    return [...duplicate, ...frameProblems(frame, path)];
  });
}

function loadRegistry(): readonly DeviceFrame[] {
  const problems = deviceFrameProblems(registry);
  if (problems.length > 0) {
    throw new Error(`deviceFrames.json is invalid: ${problems.join("; ")}`);
  }
  return registrySchema.parse(registry).frames;
}

export const DEVICE_FRAMES: readonly DeviceFrame[] = loadRegistry();

const DEFAULT_FRAME_IDS = { android: "pixel-9", ios: "iphone-16" } as const;

/** The frame used when a request names none and no closer match is known. */
export function defaultDeviceFrameId(platform: DeviceFrame["platform"]): string {
  return DEFAULT_FRAME_IDS[platform];
}

export function deviceFrameOrThrow(id: string): DeviceFrame {
  const frame = DEVICE_FRAMES.find((candidate) => candidate.id === id);
  if (!frame) {
    throw new ActionableError(
      `Unknown device frame "${id}". Valid frames: ${DEVICE_FRAMES.map((f) => f.id).join(", ")}`,
    );
  }
  return frame;
}
