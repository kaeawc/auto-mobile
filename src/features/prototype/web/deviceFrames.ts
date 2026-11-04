import { ActionableError } from "../../../models/ActionableError";
import type { DeviceFrame, DeviceFrameEntry } from "./deviceFrameSchema";
import registry from "./deviceFrames.json";

export type { DeviceFrame, DeviceFramePanel } from "./deviceFrameSchema";

/**
 * Device frames for the prototype web renderer (#16346): data-only screen geometry, so adding a
 * device is one JSON entry. Named "frame" so it never reads as the session broker's OEM
 * deviceProfile (#14058). The registry is validated against `deviceFrameSchema.ts` by its unit
 * test rather than at load, so the renderer's import closure stays free of zod (#16451); this
 * fills the schema's defaults and `inner` panel the same way, which the test also checks.
 */
export function normalizeDeviceFrame(entry: DeviceFrameEntry): DeviceFrame {
  const { hinge, ...rest } = entry;
  return {
    ...rest,
    formFactor: entry.formFactor ?? "phone",
    ...(hinge === undefined ? {} : { hinge: { ...hinge, panel: hinge.panel ?? "inner" } }),
    postures: entry.postures ?? [],
    mask: entry.mask ?? "rect",
    input: entry.input ?? "touch",
    panels: [
      {
        role: "inner",
        screen: entry.screen,
        cornerRadiusDp: entry.cornerRadiusDp,
        cutout: entry.cutout,
        statusBarDp: entry.statusBarDp,
        navBar: entry.navBar,
        safeArea: entry.safeArea,
      },
      ...(entry.panels ?? []),
    ],
  };
}

export const DEVICE_FRAMES: readonly DeviceFrame[] = (
  registry.frames as readonly DeviceFrameEntry[]
).map(normalizeDeviceFrame);

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
