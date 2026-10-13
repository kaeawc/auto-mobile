import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_BOTTOM_SHEET_DRAG_CAPABILITY,
  PROTOTYPE_ICON_SET_MATERIAL_CAPABILITY,
  PROTOTYPE_ICON_VARIANT_CAPABILITY,
  PROTOTYPE_IDENTIFIER_TEST_TAG_ONLY_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import type { PrototypeSpec } from "./prototypeSpec";

export type PrototypePlatformNoteConstruct =
  | "node.id"
  | "bottomSheet.dismissOnSwipe"
  | "bottomSheet.detents"
  | "icon.name"
  | "icon.variant";
export type PrototypePlatformNoteEffect = "ignored" | "substituted";
export interface PrototypePlatformNote {
  platform: "ios";
  construct: PrototypePlatformNoteConstruct;
  effect: PrototypePlatformNoteEffect;
  /** Paths in the component-expanded, anchor-resolved device spec, in tree order, capped at 20.
   * Includes bottomSheet.dismissOnSwipe even when the field is absent and defaulted. */
  paths: string[];
  /** Total occurrences when more than the cap were found. */
  total?: number;
  /** Distinct placeholder icon names, sorted; icon.name only. */
  values?: string[];
  detail: string;
}

/** Mirrors PrototypeRenderer.swift's sfSymbols table; the source equality test pins this set. */
export const IOS_PROTOTYPE_MAPPED_ICON_NAMES: ReadonlySet<string> = new Set([
  "home",
  "search",
  "settings",
  "person",
  "favorite",
  "add",
  "close",
  "check",
  "arrow_back",
  "arrow_forward",
  "chevron_left",
  "chevron_right",
  "menu",
  "more_vert",
  "share",
  "edit",
  "delete",
  "info",
  "warning",
  "notifications",
  "star",
  "shopping_cart",
  "help",
  "refresh",
  "done",
  "cancel",
  "play_arrow",
  "pause",
  "stop",
  "mail",
  "phone",
  "location_on",
  "calendar_today",
  "visibility",
  "lock",
  "logout",
  "alarm",
  "schedule",
  "event",
  "today",
  "remove",
  "expand_more",
  "expand_less",
  "more_horiz",
  "account_circle",
  "send",
  "bookmark",
  "thumb_up",
  "photo_camera",
  "image",
  "music_note",
  "wifi",
  "sort",
  "filter_list",
  "content_copy",
]);

interface Occurrence {
  path: string;
  node?: Record<string, unknown>;
  icon?: string;
}
interface PlatformDifference {
  construct: PrototypePlatformNoteConstruct;
  platform: "ios";
  effect: PrototypePlatformNoteEffect;
  capability: string;
  detail: string;
  occurrencePath: (site: Occurrence) => string | undefined;
}

/** One table drives both show notes and the generated guide. */
export const PROTOTYPE_PLATFORM_DIFFERENCES: readonly PlatformDifference[] = [
  {
    construct: "node.id",
    platform: "ios",
    effect: "substituted",
    capability: PROTOTYPE_IDENTIFIER_TEST_TAG_ONLY_CAPABILITY,
    detail:
      "iOS uses id as the accessibility identifier (and <id>.<part> for composite parts) when testTag is absent; Android gives such a node no identifier, so set testTag for an identifier on both.",
    occurrencePath: ({ node, path }) =>
      node?.id !== undefined && node.testTag === undefined ? `${path}.id` : undefined,
  },
  {
    construct: "bottomSheet.dismissOnSwipe",
    platform: "ios",
    effect: "ignored",
    capability: PROTOTYPE_BOTTOM_SHEET_DRAG_CAPABILITY,
    detail:
      "iOS has no swipe-to-dismiss and the sheet closes only through its openWhen key or a scrim tap; Android supports swipe-to-dismiss by default.",
    occurrencePath: ({ node, path }) =>
      node?.type === "bottomSheet" && node.dismissOnSwipe !== false
        ? `${path}.dismissOnSwipe`
        : undefined,
  },
  {
    construct: "bottomSheet.detents",
    platform: "ios",
    effect: "ignored",
    capability: PROTOTYPE_BOTTOM_SHEET_DRAG_CAPABILITY,
    detail:
      "iOS opens the sheet at its first detent and cannot drag to the others; Android supports dragging between detents.",
    occurrencePath: ({ node, path }) =>
      node?.type === "bottomSheet" && Array.isArray(node.detents) && node.detents.length > 1
        ? `${path}.detents`
        : undefined,
  },
  {
    construct: "icon.name",
    platform: "ios",
    effect: "substituted",
    capability: PROTOTYPE_ICON_SET_MATERIAL_CAPABILITY,
    detail:
      "iOS draws a placeholder symbol for unmapped built-in icon names; Android draws the Material icon.",
    occurrencePath: ({ icon, path }) =>
      icon !== undefined && !IOS_PROTOTYPE_MAPPED_ICON_NAMES.has(icon) ? path : undefined,
  },
  {
    construct: "icon.variant",
    platform: "ios",
    effect: "ignored",
    capability: PROTOTYPE_ICON_VARIANT_CAPABILITY,
    detail:
      "iOS draws its one SF Symbol for the name regardless of variant; Android draws the requested Material style.",
    occurrencePath: ({ node, path }) =>
      node?.type === "icon" && node.variant !== undefined ? `${path}.variant` : undefined,
  },
];

interface Rule {
  kind: string;
  name?: string;
  item?: Rule;
  fields?: Record<string, { rule: Rule }>;
  variants?: Record<string, Rule>;
}
const definitions: Record<string, Rule> = contract.definitions;

/** Contract references identify real nodes and every iconName slot, including nested item slots.
 * The validator and anchor walkers are private and cannot be reused; this uses their dot/index
 * notation and walks depth first in contract field order. Validated device specs only.
 */
function occurrences(value: unknown, rule: Rule, path: string, found: Occurrence[]): void {
  if (value === undefined || value === null) {
    return;
  }
  switch (rule.kind) {
    case "ref":
      referenceOccurrences(value, rule.name!, path, found);
      break;
    case "array":
      (value as unknown[]).forEach((entry, index) =>
        occurrences(entry, rule.item!, `${path}[${index}]`, found),
      );
      break;
    case "object": {
      const data = value as Record<string, unknown>;
      for (const [key, field] of Object.entries(rule.fields ?? {})) {
        occurrences(data[key], field.rule, path ? `${path}.${key}` : key, found);
      }
      break;
    }
    case "tagged": {
      const data = value as Record<string, unknown>;
      const variant = rule.variants?.[String(data.type)];
      if (variant) {
        occurrences(value, variant, path, found);
      }
      break;
    }
  }
}

function referenceOccurrences(
  value: unknown,
  name: string,
  path: string,
  found: Occurrence[],
): void {
  if (name === "iconName" && typeof value === "string") {
    found.push({ path, icon: value });
  }
  if (name === "node") {
    found.push({ path, node: value as Record<string, unknown> });
  }
  occurrences(value, definitions[name]!, path, found);
}

/** Reports the supplied (normally host-expanded device) spec without I/O or mutation. */
export function prototypePlatformNotes(
  spec: PrototypeSpec,
  platform: "android" | "ios",
  supports: (capability: string) => boolean,
): PrototypePlatformNote[] {
  if (platform === "android") {
    return [];
  }
  const found: Occurrence[] = [];
  occurrences(spec.root, { kind: "ref", name: "node" }, "root", found);
  return PROTOTYPE_PLATFORM_DIFFERENCES.flatMap((difference) => {
    if (supports(difference.capability)) {
      return [];
    }
    const affected = found.flatMap((site) => {
      const path = difference.occurrencePath(site);
      return path === undefined ? [] : [{ path, icon: site.icon }];
    });
    if (affected.length === 0) {
      return [];
    }
    return [
      {
        platform: difference.platform,
        construct: difference.construct,
        effect: difference.effect,
        paths: affected.slice(0, 20).map(({ path }) => path),
        ...(affected.length > 20 ? { total: affected.length } : {}),
        ...(difference.construct === "icon.name"
          ? { values: [...new Set(affected.map(({ icon }) => icon!))].sort() }
          : {}),
        detail: difference.detail,
      },
    ];
  });
}
