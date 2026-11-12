import { z } from "zod/v3";
import type { FormFactor } from "../../../models/DeviceMatchCriteria";
import type { PanelRole, Posture } from "../../../models/DisplayPanel";

/**
 * The strict schema for `deviceFrames.json` (#16346). It lives apart from the registry so the
 * still renderer's browser bundle never carries zod (#16451); the registry is checked by its unit
 * test. Each frame's `source` provenance lives in `deviceFrameSources.json`, keyed by frame id,
 * so the bundle never carries it either (#16809); the schema checks the two merged with
 * `withDeviceFrameSources`.
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

const navBarSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.enum(["gesture", "buttons"]), heightDp: dp() }).strict(),
]);

/** The v1 screen fields; a v2 frame repeats them once per panel. */
const panelFields = {
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
  navBar: navBarSchema,
  safeArea: z.object({ portrait: insets(), landscape: insets() }).strict(),
};

/** Physical panel roles from DisplayPanel; `overlay`, `virtual` and `unknown` never describe a frame. */
const PANEL_ROLES = ["inner", "cover", "rear", "external"] as const satisfies readonly PanelRole[];
const panelRole = z.enum(PANEL_ROLES);
const extraPanelSchema = z.object({ role: panelRole.exclude(["inner"]), ...panelFields }).strict();

const FORM_FACTORS = [
  "phone",
  "tablet",
  "foldable",
  "tv",
  "watch",
  "automotive",
] as const satisfies readonly FormFactor[];

/** The `setPosture` names, without `unknown`. */
const POSTURES = [
  "closed",
  "half_opened",
  "opened",
  "rear_display",
  "flipped",
  "tent",
] as const satisfies readonly Posture[];

const hingeSchema = z
  .object({
    axis: z.enum(["vertical", "horizontal"]),
    /** The panel the hinge folds. */
    panel: panelRole.default("inner"),
    /** Offset of the hinge's leading edge from the panel's left (vertical) or top (horizontal) edge, in portrait. */
    positionDp: dp(),
    /** 0 for a seamless fold. */
    widthDp: dp(),
    /** An occluding hinge removes `widthDp` from the layout. */
    occluding: z.boolean(),
  })
  .strict();

const postureSchema = z
  .object({
    posture: z.enum(POSTURES),
    panel: panelRole,
    hingeDegrees: z.number().finite().min(0).max(360),
  })
  .strict();

const SOURCE_KINDS = ["publicSpec", "avdProfile", "simulatorProfile", "measured"] as const;

const sourceSchema = z
  .object({
    screen: z.string().min(1),
    insets: z.string().min(1),
    hinge: z.string().min(1).optional(),
    /** Per-field kind, so measured and published values stay distinguishable. */
    kinds: z
      .object({
        screen: z.enum(SOURCE_KINDS).optional(),
        insets: z.enum(SOURCE_KINDS).optional(),
        hinge: z.enum(SOURCE_KINDS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Frame schema v2 (#16444, docs/design-docs/prototype-web-frames-v2.md). The top-level screen
 * fields are the `inner` panel, so every v1 entry is a v2 frame with one panel. `panels` in JSON
 * lists the other panels; the parsed frame's `panels` starts with the `inner` one.
 */
const deviceFrameSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    platform: z.enum(["android", "ios"]),
    label: z.string().min(1).max(64),
    formFactor: z.enum(FORM_FACTORS).default("phone"),
    ...panelFields,
    panels: z.array(extraPanelSchema).max(3).default([]),
    hinge: hingeSchema.optional(),
    postures: z.array(postureSchema).max(POSTURES.length).default([]),
    mask: z.enum(["rect", "round"]).default("rect"),
    input: z.enum(["touch", "dpad", "rotary"]).default("touch"),
    frame: z.object({ bezelDp: dp(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict(),
    /** Where the geometry came from, per entry, so unmeasured values stay visible. */
    source: sourceSchema,
  })
  .strict()
  .transform((frame) => ({
    ...frame,
    panels: [
      {
        role: "inner" as const,
        screen: frame.screen,
        cornerRadiusDp: frame.cornerRadiusDp,
        cutout: frame.cutout,
        statusBarDp: frame.statusBarDp,
        navBar: frame.navBar,
        safeArea: frame.safeArea,
      },
      ...frame.panels,
    ],
  }));

const registrySchema = z.object({ frames: z.array(deviceFrameSchema).min(1) }).strict();

type SourcedDeviceFrame = z.output<typeof deviceFrameSchema>;
/** A frame as the renderer sees it: its `source` stays in `deviceFrameSources.json`. */
export type DeviceFrame = Omit<SourcedDeviceFrame, "source">;
/** A registry entry as written in JSON, before defaults and the `inner` panel are filled in. */
export type DeviceFrameEntry = Omit<z.input<typeof deviceFrameSchema>, "source">;
export type DeviceFramePanel = DeviceFrame["panels"][number];
type Insets = DeviceFramePanel["safeArea"]["portrait"];

export function parseDeviceFrames(value: unknown) {
  return registrySchema.safeParse(value);
}

/** The registry with each frame's `source` from the sources file (keyed by frame id) merged in. */
export function withDeviceFrameSources<F extends { readonly id: string }, S>(
  registry: { readonly frames: readonly F[] },
  sources: Readonly<Record<string, S>>,
): { frames: (F & { source: S | undefined })[] } {
  return { frames: registry.frames.map((frame) => ({ ...frame, source: sources[frame.id] })) };
}

/** Source entries whose id names no frame in the registry. */
export function orphanDeviceFrameSources(
  registry: { readonly frames: readonly { readonly id: string }[] },
  sources: Readonly<Record<string, unknown>>,
): string[] {
  const ids = new Set(registry.frames.map((frame) => frame.id));
  return Object.keys(sources)
    .filter((id) => !ids.has(id))
    .map((id) => `sources.${id}: names no frame`);
}

function cutoutOutsideScreen(panel: DeviceFramePanel): boolean {
  const { cutout, screen } = panel;
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

function panelProblems(panel: DeviceFramePanel, path: string): string[] {
  const { widthDp, heightDp } = panel.screen;
  return [
    cutoutOutsideScreen(panel) ? `${path}.cutout: lies outside the portrait screen` : undefined,
    leavesNoScreen(panel.safeArea.portrait, widthDp, heightDp)
      ? `${path}.safeArea.portrait: insets leave no screen`
      : undefined,
    leavesNoScreen(panel.safeArea.landscape, heightDp, widthDp)
      ? `${path}.safeArea.landscape: insets leave no screen`
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
}

/** Panel 0 is the top-level fields; the rest are `panels[i - 1]` in the JSON entry. */
function panelPath(path: string, index: number): string {
  return index === 0 ? path : `${path}.panels[${index - 1}]`;
}

function hingeProblems(frame: DeviceFrame, path: string): string[] {
  const { hinge } = frame;
  if (!hinge) {
    return [];
  }
  const panel = frame.panels.find((candidate) => candidate.role === hinge.panel);
  if (!panel) {
    return [`${path}.hinge.panel: the frame has no "${hinge.panel}" panel`];
  }
  const extent = hinge.axis === "vertical" ? panel.screen.widthDp : panel.screen.heightDp;
  const within = hinge.positionDp > 0 && hinge.positionDp + hinge.widthDp < extent;
  return within ? [] : [`${path}.hinge: lies outside its "${hinge.panel}" panel`];
}

function postureProblems(frame: DeviceFrame, path: string): string[] {
  const roles = new Set(frame.panels.map((panel) => panel.role));
  const seen = new Set<string>();
  return frame.postures.flatMap((entry, index) => {
    const entryPath = `${path}.postures[${index}]`;
    const duplicate = seen.has(entry.posture)
      ? [`${entryPath}.posture: duplicate posture "${entry.posture}"`]
      : [];
    seen.add(entry.posture);
    const missing = roles.has(entry.panel)
      ? []
      : [`${entryPath}.panel: the frame has no "${entry.panel}" panel`];
    return [...duplicate, ...missing];
  });
}

function duplicatePanelProblems(frame: DeviceFrame, path: string): string[] {
  const seen = new Set<string>();
  return frame.panels.flatMap((panel, index) => {
    const duplicate = seen.has(panel.role)
      ? [`${panelPath(path, index)}.role: duplicate panel role "${panel.role}"`]
      : [];
    seen.add(panel.role);
    return duplicate;
  });
}

function frameProblems(frame: SourcedDeviceFrame, path: string): string[] {
  return [
    ...duplicatePanelProblems(frame, path),
    ...frame.panels.flatMap((panel, index) => panelProblems(panel, panelPath(path, index))),
    ...hingeProblems(frame, path),
    ...(frame.hinge && !frame.source.hinge ? [`${path}.source.hinge: a hinge needs a source`] : []),
    ...postureProblems(frame, path),
  ];
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
