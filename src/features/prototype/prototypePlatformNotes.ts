import iconSymbols from "../../../schemas/prototype-ios-icon-symbols.json";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_BOTTOM_SHEET_DRAG_CAPABILITY,
  PROTOTYPE_ICON_SET_MATERIAL_CAPABILITY,
  PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY,
  PROTOTYPE_ICON_VARIANT_CAPABILITY,
  PROTOTYPE_IDENTIFIER_TEST_TAG_ONLY_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import type { PrototypeSpec } from "./prototypeSpec";

export type PrototypePlatformNoteConstruct =
  | "node.id"
  | "bottomSheet.dismissOnSwipe"
  | "bottomSheet.detents"
  | "icon.name"
  | "icon.variant"
  | "searchBar"
  | "searchBar.icons";
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

/** Frozen legacy set for agents without prototype_icon_sf_symbols_v1; no longer mirrored from Swift. */
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
  nodeType?: string;
}
interface PlatformDifference {
  construct: PrototypePlatformNoteConstruct;
  platform: "ios";
  effect: PrototypePlatformNoteEffect;
  capability?: string;
  detail: string;
  occurrencePath: (site: Occurrence) => string | undefined;
}

/** Permanent renderer differences, independent of advertised capabilities. */
export const PROTOTYPE_SEARCH_BAR_PLATFORM_DIFFERENCES: readonly PlatformDifference[] = [
  {
    construct: "searchBar",
    platform: "ios",
    effect: "substituted",
    detail:
      "iOS draws the search field inside the prototype window instead of using SwiftUI .searchable, which requires a NavigationStack; results remain ordinary observable child nodes.",
    occurrencePath: ({ node, path }) => (node?.type === "searchBar" ? path : undefined),
  },
  {
    construct: "searchBar.icons",
    platform: "ios",
    effect: "substituted",
    detail:
      "iOS maps searchBar leading and trailing icons to SF Symbols; it never draws Android Material glyphs.",
    occurrencePath: ({ icon, path, nodeType }) =>
      icon !== undefined && nodeType === "searchBar" ? path : undefined,
  },
];

/** One table drives both show notes and the generated guide. */
export const PROTOTYPE_PLATFORM_DIFFERENCES: readonly (PlatformDifference & {
  capability: string;
})[] = [
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
      "This iOS agent lacks prototype_icon_sf_symbols_v1 and draws a placeholder for names outside its legacy mapping; relaunch with a current agent. Android draws the Material icon.",
    occurrencePath: ({ icon, path }) =>
      icon !== undefined && !IOS_PROTOTYPE_MAPPED_ICON_NAMES.has(icon) ? path : undefined,
  },
  {
    construct: "icon.variant",
    platform: "ios",
    effect: "ignored",
    capability: PROTOTYPE_ICON_VARIANT_CAPABILITY,
    detail:
      "This iOS agent lacks prototype_icon_sf_symbols_v1 and ignores icon variants; relaunch with a current agent. Android draws the requested Material style.",
    occurrencePath: ({ node, path }) =>
      node?.type === "icon" && node.variant !== undefined ? `${path}.variant` : undefined,
  },
];

const mappedSymbols: Readonly<
  Record<string, { symbol: string; filled?: string; outlined?: string }>
> = iconSymbols.mapped;

function sfSymbolDifference(difference: PlatformDifference): PlatformDifference {
  if (difference.construct === "icon.name") {
    return {
      ...difference,
      detail:
        "iOS draws SF Symbols; these names have no SF Symbol equivalent, so a placeholder symbol is drawn.",
      occurrencePath: ({ icon, path }) =>
        icon !== undefined && !Object.hasOwn(mappedSymbols, icon) ? path : undefined,
    };
  }
  if (difference.construct === "icon.variant") {
    return {
      ...difference,
      effect: "substituted",
      detail:
        "SF Symbols have no rounded, sharp or twoTone style; filled/outlined require a table form. For these variants iOS draws the name's default symbol.",
      occurrencePath: ({ node, path }) => {
        if (
          node?.type !== "icon" ||
          typeof node.name !== "string" ||
          !Object.hasOwn(mappedSymbols, node.name)
        ) {
          return undefined;
        }
        const entry = mappedSymbols[node.name];
        const variant = node.variant;
        return variant === "rounded" ||
          variant === "sharp" ||
          variant === "twoTone" ||
          (variant === "filled" && entry.filled === undefined) ||
          (variant === "outlined" && entry.outlined === undefined)
          ? `${path}.variant`
          : undefined;
      },
    };
  }
  return difference;
}

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
function occurrences(
  value: unknown,
  rule: Rule,
  path: string,
  found: Occurrence[],
  nodeType?: string,
): void {
  if (value === undefined || value === null) {
    return;
  }
  switch (rule.kind) {
    case "ref":
      referenceOccurrences(value, rule.name!, path, found, nodeType);
      break;
    case "array":
      (value as unknown[]).forEach((entry, index) =>
        occurrences(entry, rule.item!, `${path}[${index}]`, found, nodeType),
      );
      break;
    case "object": {
      const data = value as Record<string, unknown>;
      for (const [key, field] of Object.entries(rule.fields ?? {})) {
        occurrences(data[key], field.rule, path ? `${path}.${key}` : key, found, nodeType);
      }
      break;
    }
    case "tagged": {
      const data = value as Record<string, unknown>;
      const variant = rule.variants?.[String(data.type)];
      if (variant) {
        occurrences(value, variant, path, found, nodeType);
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
  nodeType?: string,
): void {
  if (name === "iconName" && typeof value === "string") {
    found.push({ path, icon: value, nodeType });
  }
  if (name === "node") {
    found.push({ path, node: value as Record<string, unknown> });
    nodeType = String((value as Record<string, unknown>).type);
  }
  occurrences(value, definitions[name]!, path, found, nodeType);
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
  const sfSymbols = supports(PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY);
  const differences = [
    ...PROTOTYPE_PLATFORM_DIFFERENCES,
    ...PROTOTYPE_SEARCH_BAR_PLATFORM_DIFFERENCES,
  ];
  return differences.flatMap((legacyDifference) => {
    const difference = sfSymbols ? sfSymbolDifference(legacyDifference) : legacyDifference;
    if (difference.capability && supports(difference.capability)) {
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
