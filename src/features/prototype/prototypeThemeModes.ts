import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { PROTOTYPE_THEME_MODES_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/**
 * Finds the spec fields that use a per-mode form (#11218), which only a device advertising
 * `prototype_theme_modes_v1` can draw: a `{light, dark}` colour pair, a role name in a gradient
 * stop or scrim (hex-only before), `theme.colors.light` / `theme.colors.dark`, and a
 * `{light, dark}` image asset. Paths use the validator's spelling, in document order.
 */
export function prototypeThemeModeFields(spec: unknown): string[] {
  const root = record(spec);
  if (!root) {
    return [];
  }
  const colors = record(record(root.theme)?.colors);
  return [
    ...["light", "dark"]
      .filter((mode) => colors?.[mode] !== undefined)
      .map((mode) => `theme.colors.${mode}`),
    ...newlyThemedColor(record(record(root.window)?.placement)?.scrim, "window.placement.scrim"),
    ...prototypeSpecNodeRoots(spec).flatMap(({ node, path }) => nodeFields(node, path)),
  ];
}

/** The refusal for a device that does not advertise the capability; names the first field. */
export function prototypeThemeModesUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_THEME_MODES_CAPABILITY}, so it cannot draw the per-mode value at ${fields[0]}${more}: {light, dark} colour and image pairs, role names in gradient stops and scrims, and theme.colors.light / theme.colors.dark. Nothing was shown. ${update}, or use a single hex value, a role name where one was already allowed, or one asset id.`;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pairAt(value: unknown, path: string): string[] {
  // `{data: "/pointer"}` is a media item binding (#14192), not a per-mode pair.
  const pair = record(value);
  return pair && pair.data === undefined ? [path] : [];
}

/** A slot that took hex only before: a pair or a role name both need the capability. */
function newlyThemedColor(value: unknown, path: string): string[] {
  return record(value) || (typeof value === "string" && !value.startsWith("#")) ? [path] : [];
}

function styleFields(value: unknown, path: string): string[] {
  const style = record(value);
  if (!style) {
    return [];
  }
  return [
    ...["background", "color", "shadowColor"].flatMap((key) =>
      pairAt(style[key], `${path}.${key}`),
    ),
    ...list(style.shadows).flatMap((shadow, index) =>
      pairAt(record(shadow)?.color, `${path}.shadows[${index}].color`),
    ),
    ...list(record(record(style.border)?.gradient)?.stops).flatMap((stop, index) =>
      newlyThemedColor(record(stop)?.color, `${path}.border.gradient.stops[${index}].color`),
    ),
    ...pairAt(record(style.border)?.color, `${path}.border.color`),
    ...list(record(style.gradient)?.stops).flatMap((stop, index) =>
      newlyThemedColor(record(stop)?.color, `${path}.gradient.stops[${index}].color`),
    ),
  ];
}

function nodeFields(value: unknown, path: string): string[] {
  const fields: string[] = [];
  const pending = [{ node: value, path }];
  while (pending.length) {
    const { node: value, path } = pending.pop()!;
    const node = record(value);
    if (!node) {
      continue;
    }
    fields.push(
      ...pairAt(record(node.filter)?.tint, `${path}.filter.tint`),
      ...styleFields(node.style, `${path}.style`),
      ...list(node.styleWhen).flatMap((entry, index) =>
        styleFields(record(entry)?.style, `${path}.styleWhen[${index}].style`),
      ),
      ...(node.type === "image" ? pairAt(node.asset, `${path}.asset`) : []),
      ...(node.type === "bottomSheet" || node.type === "drawer"
        ? newlyThemedColor(node.scrim, `${path}.scrim`)
        : []),
      ...list(node.items).flatMap((item, index) =>
        pairAt(record(item)?.image, `${path}.items[${index}].image`),
      ),
    );
    const children = prototypeNodeChildren(node).sort((left, right) => {
      const rank = (suffix: string): number =>
        suffix.startsWith(".children[") ? 0 : suffix === ".child" ? 1 : 2;
      return rank(left.suffix) - rank(right.suffix);
    });
    for (const child of children.reverse()) {
      pending.push({ node: child.value, path: `${path}${child.suffix}` });
    }
  }
  return fields;
}
