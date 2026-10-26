import { PROTOTYPE_MOTION_V2_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { prototypeTransitionType } from "./prototypeChoreography";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Motion and gestures (#14208): a node-level `animate` that animates styleWhen-driven changes, the
 * `scale` and `rotation` style properties, the `slideStart`, `slideEnd` and `scale` transitions,
 * and `zoomable` images. All of it is gated by `prototype_motion_v2`.
 */
export const PROTOTYPE_MOTION_V2_TRANSITIONS = ["slideStart", "slideEnd", "scale"] as const;
const STYLE_FIELDS = ["scale", "rotation"] as const;

export interface PrototypeMotionV2Error {
  path: string;
  message: string;
}

/** A zoomable image claims the double tap, so it cannot also run `onDoubleTap`. */
export function prototypeMotionV2Error(
  nodes: readonly { value: Raw; path: string }[],
): PrototypeMotionV2Error | undefined {
  const node = nodes.find(
    ({ value }) =>
      value.type === "image" && value.zoomable !== undefined && value.onDoubleTap !== undefined,
  );
  return node
    ? { path: `${node.path}.zoomable`, message: "A zoomable image cannot also have onDoubleTap" }
    : undefined;
}

function styleFields(style: unknown, path: string): string[] {
  const fields = record(style);
  return fields
    ? STYLE_FIELDS.filter((field) => fields[field] !== undefined).map((field) => `${path}.${field}`)
    : [];
}

function nodeFields(node: Raw, path: string): string[] {
  const styleWhen = Array.isArray(node.styleWhen) ? node.styleWhen : [];
  return [
    ...(node.animate !== undefined ? [`${path}.animate`] : []),
    ...(node.type !== "stack" &&
    (PROTOTYPE_MOTION_V2_TRANSITIONS as readonly unknown[]).includes(
      prototypeTransitionType(node.transition),
    )
      ? [`${path}.transition`]
      : []),
    ...styleFields(node.style, `${path}.style`),
    ...styleWhen.flatMap((entry, index) =>
      styleFields(record(entry)?.style, `${path}.styleWhen[${index}].style`),
    ),
    ...(node.type === "image" && node.zoomable !== undefined ? [`${path}.zoomable`] : []),
  ];
}

/** Authored paths of every motion-v2 field, in tree order. */
export function prototypeMotionV2Fields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    fields.push(...nodeFields(node, path));
  });
  return fields;
}

export function prototypeMotionV2UnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_MOTION_V2_CAPABILITY}, so it cannot run the motion at ${fields[0]}${more}. Nothing was shown. ${update}, or use instant styleWhen changes and the fade, expand or slide transitions.`;
}
