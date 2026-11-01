import { prototypeGlassEdgeNotes } from "./prototypeGlassNotes";
import { prototypeAdaptiveNotes } from "./prototypeAdaptive";
import { prototypeNamespaceNotes } from "./prototypeNamespaceNotes";
import { designFallbackPaths } from "./prototypeDesign";
import { prototypeStringsFallbackKeys } from "./prototypeStrings";
import { prototypeIgnoredNamespaceFields } from "./prototypePlatformNamespace";
import iconSymbols from "../../../schemas/prototype-ios-icon-symbols.json";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_TEXT_FIELD_MATERIAL_STYLE_CAPABILITY,
  PROTOTYPE_BOTTOM_SHEET_DRAG_CAPABILITY,
  PROTOTYPE_ICON_SET_MATERIAL_CAPABILITY,
  PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY,
  PROTOTYPE_ICON_VARIANT_CAPABILITY,
  PROTOTYPE_IDENTIFIER_TEST_TAG_ONLY_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { prototypeZoomTransitionNotes } from "./prototypeZoomTransition";
import { prototypeIconEffectNotes } from "./prototypeIconEffectNotes";
import type { PrototypeSpec } from "./prototypeSpec";

export type PrototypePlatformNoteConstruct =
  | "adaptive"
  | "design.fallback"
  | "platformNamespace"
  | "scroll.edgeEffect"
  | "rich-text-links"
  | "stack.zoom"
  | "stack"
  | "carousel"
  | "node.id"
  | "bottomSheet.dismissOnSwipe"
  | "bottomSheet.detents"
  | "icon.effect"
  | "icon.name"
  | "icon.variant"
  | "textField.variant"
  | "textField.label"
  | "searchBar"
  | "searchBar.icons"
  | "menu"
  | "select"
  | "strings.fallback";
export type PrototypePlatformNoteEffect = "ignored" | "substituted";
export interface PrototypePlatformNote {
  platform: "android" | "ios" | "all";
  construct: PrototypePlatformNoteConstruct;
  effect: PrototypePlatformNoteEffect;
  /** Paths in the component-expanded, anchor-resolved device spec, in tree order, capped at 20.
   * Includes bottomSheet.dismissOnSwipe even when the field is absent and defaulted. */
  paths: string[];
  /** Total occurrences when more than the cap were found. */
  total?: number;
  /** icon.name: sorted distinct placeholders; strings.fallback: up to 20 referenced keys. */
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
  capability?: string;
})[] = [
  {
    construct: "node.id",
    platform: "ios",
    effect: "substituted",
    capability: PROTOTYPE_IDENTIFIER_TEST_TAG_ONLY_CAPABILITY,
    detail:
      "An iOS agent without prototype_identifier_test_tag_only_v1 uses id as the accessibility identifier (and <id>.<part> for composite parts) when testTag is absent; Android gives such a node no identifier, so set testTag for an identifier on both.",
    occurrencePath: ({ node, path }) =>
      node?.id !== undefined && node.testTag === undefined ? `${path}.id` : undefined,
  },
  {
    construct: "bottomSheet.dismissOnSwipe",
    platform: "ios",
    effect: "ignored",
    capability: PROTOTYPE_BOTTOM_SHEET_DRAG_CAPABILITY,
    detail:
      "An iOS agent without prototype_bottom_sheet_drag_v1 has no swipe-to-dismiss and the sheet closes only through its openWhen key or a scrim tap; Android supports swipe-to-dismiss by default.",
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
      "An iOS agent without prototype_bottom_sheet_drag_v1 opens the sheet at its first detent and cannot drag to the others; Android supports dragging between detents.",
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
  {
    construct: "textField.variant",
    platform: "ios",
    effect: "substituted",
    capability: PROTOTYPE_TEXT_FIELD_MATERIAL_STYLE_CAPABILITY,
    detail:
      "An iOS agent without prototype_text_field_material_style_v1 has no native outlined text field; the agent draws a rounded outline around a standard SwiftUI TextField. Android draws the Material outlined field.",
    occurrencePath: ({ node, path }) =>
      node?.type === "textField" && node.variant === "outlined" ? `${path}.variant` : undefined,
  },
  {
    construct: "textField.label",
    platform: "ios",
    effect: "substituted",
    capability: PROTOTYPE_TEXT_FIELD_MATERIAL_STYLE_CAPABILITY,
    detail:
      "An iOS agent without prototype_text_field_material_style_v1 has no native floating label; the agent draws the label as a caption above the field that does not animate. Android draws the Material floating label.",
    occurrencePath: ({ node, path }) =>
      node?.type === "textField" && node.label !== undefined ? `${path}.label` : undefined,
  },
  {
    construct: "stack",
    platform: "ios",
    effect: "substituted",
    detail:
      "Platform, slide and zoom support interactive edge pop; only the composed sharedAxisX/Y and fadeThrough patterns pop non-interactively. Pattern values and source require prototype_stack_patterns_v1. iOS pops a stack with the left-edge swipe (no system back button chrome); Android uses system Back above depth 1. Explicit stack or push/replace transitions require prototype_stack_transitions_v1. iOS Reduce Motion uses fades; Android animator or transition scale 0 makes transitions instant.",
    occurrencePath: ({ node, path }) => (node?.type === "stack" ? path : undefined),
  },
  {
    construct: "carousel",
    platform: "ios",
    effect: "substituted",
    detail:
      "iOS has no Material carousel: every variant draws fixed-width items (itemWidth) in a snapping horizontal scroll, without the multiBrowse or hero size changes, and all items stay in the hierarchy. Android composes only the visible items.",
    occurrencePath: ({ node, path }) => (node?.type === "carousel" ? path : undefined),
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
  fields?: Record<string, { rule: Rule } | undefined>;
  variants?: Record<string, Rule>;
  options?: Rule[];
}
const definitions: Record<string, Rule> = contract.definitions;

/** Contract references identify real nodes and every iconName slot, including nested item slots.
 * The validator and anchor walkers are private and cannot be reused; this uses their dot/index
 * notation and walks depth first in contract field order. Validated device specs only.
 */
function skipsOccurrences(value: unknown, rule: Rule): boolean {
  return (
    value === undefined ||
    value === null ||
    rule.name === "iosNamespace" ||
    rule.name === "androidNamespace"
  );
}

function occurrences(
  value: unknown,
  rule: Rule,
  path: string,
  { found, nodeType }: { found: Occurrence[]; nodeType?: string },
): void {
  if (skipsOccurrences(value, rule)) {
    return;
  }
  switch (rule.kind) {
    case "ref":
      referenceOccurrences(value, rule.name!, path, { found, nodeType });
      break;
    case "strings":
      break;
    case "screenMap":
      Object.entries(value as Record<string, unknown>).forEach(([name, child]) =>
        occurrences(child, rule.item!, `${path}[${JSON.stringify(name)}]`, { found }),
      );
      break;
    case "array":
      (value as unknown[]).forEach((entry, index) =>
        occurrences(entry, rule.item!, `${path}[${index}]`, { found, nodeType }),
      );
      break;
    case "object":
      objectOccurrences(value as Record<string, unknown>, rule, path, { found, nodeType });
      break;
    case "tagged": {
      const data = value as Record<string, unknown>;
      const variant = rule.variants?.[String(data.type)];
      if (variant) {
        occurrences(value, variant, path, { found, nodeType });
      }
      break;
    }
  }
}

function objectOccurrences(
  data: Record<string, unknown>,
  rule: Rule,
  path: string,
  { found, nodeType }: { found: Occurrence[]; nodeType?: string },
): void {
  for (const [key, field] of Object.entries(rule.fields ?? {})) {
    // Imported JSON has no undefined entries; only union inference makes fields optional.
    occurrences(data[key], field!.rule, path ? `${path}.${key}` : key, { found, nodeType });
  }
}

function referenceOccurrences(
  value: unknown,
  name: string,
  path: string,
  { found, nodeType }: { found: Occurrence[]; nodeType?: string },
): void {
  if (name === "iconName" && typeof value === "string") {
    found.push({ path, icon: value, nodeType });
  }
  if (name === "node") {
    found.push({ path, node: value as Record<string, unknown> });
    nodeType = String((value as Record<string, unknown>).type);
  }
  occurrences(
    value,
    name === "menuItem" ? definitions.menuItem!.options![0]! : definitions[name]!,
    path,
    { found, nodeType },
  );
}

/** Reports the supplied (normally host-expanded device) spec without I/O or mutation. */
export function prototypePlatformNotes(
  spec: PrototypeSpec,
  platform: "android" | "ios",
  supports: (capability: string) => boolean,
  osMajor?: number,
): PrototypePlatformNote[] {
  const edgeNotes = prototypeGlassEdgeNotes(spec, platform, osMajor);
  const zoomNotes = [
    ...edgeNotes,
    ...prototypeZoomTransitionNotes(spec, platform, supports, osMajor),
  ];
  const foreign = platform === "android" ? "ios" : "android";
  const paths = prototypeIgnoredNamespaceFields(spec, foreign);
  const foreignNotes: PrototypePlatformNote[] = paths.length
    ? [
        {
          platform,
          construct: "platformNamespace",
          effect: "ignored",
          paths: paths.slice(0, 20),
          ...(paths.length > 20 ? { total: paths.length } : {}),
          detail: `${foreign} namespace blocks are ignored on ${platform}.`,
        },
      ]
    : [];
  const namespaceNotes = [...foreignNotes, ...prototypeNamespaceNotes(spec, platform, osMajor)];
  if (platform === "android") {
    return [
      ...prototypeAdaptiveNotes(spec, platform),
      ...namespaceNotes,
      ...zoomNotes,
      ...prototypeIconEffectNotes(spec, platform),
    ];
  }
  const found: Occurrence[] = [];
  occurrences(spec.root, { kind: "ref", name: "node" }, "root", { found });
  const sfSymbols = supports(PROTOTYPE_ICON_SF_SYMBOLS_CAPABILITY);
  const differences = [
    ...PROTOTYPE_PLATFORM_DIFFERENCES,
    ...PROTOTYPE_SEARCH_BAR_PLATFORM_DIFFERENCES,
  ];
  const notes = differences.flatMap((legacyDifference) => {
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
  const links = found.flatMap(({ node, path }) =>
    node?.type === "text" && Array.isArray(node.spans)
      ? node.spans.flatMap((span: unknown, index: number) =>
          typeof span === "object" && span !== null && "onTap" in span
            ? [`${path}.spans[${index}].onTap`]
            : [],
        )
      : [],
  );
  if (links.length > 0) {
    notes.push({
      platform: "ios",
      construct: "rich-text-links",
      effect: "substituted",
      paths: links.slice(0, 20),
      ...(links.length > 20 ? { total: links.length } : {}),
      detail:
        "Tappable text spans render as links; the agent does not expose them as separate accessibility elements or semantic links. Use tapAt on the span.",
    });
  }
  const menus = (["menu", "select"] as const).flatMap((type): PrototypePlatformNote[] => {
    const paths = found.filter(({ node }) => node?.type === type).map(({ path }) => path);
    return paths.length === 0
      ? []
      : [
          {
            platform: "ios",
            construct: type,
            effect: "substituted",
            paths: paths.slice(0, 20),
            ...(paths.length > 20 ? { total: paths.length } : {}),
            detail:
              "iOS draws menu/select in the prototype window rather than the system Menu/Picker popup so observe and tapOn can reach the items.",
          },
        ];
  });
  const fallbackPaths = designFallbackPaths(spec);
  if (fallbackPaths.length) {
    notes.push({
      platform: "ios",
      construct: "design.fallback",
      effect: "substituted",
      paths: fallbackPaths.slice(0, 20),
      ...(fallbackPaths.length > 20 ? { total: fallbackPaths.length } : {}),
      detail:
        "These nodes have no native iOS coverage yet and keep the Material drawing (see designCoverage).",
    });
  }
  return [
    ...notes,
    ...zoomNotes,
    ...menus,
    ...prototypeAdaptiveNotes(spec, platform),
    ...namespaceNotes,
    ...prototypeIconEffectNotes(spec, platform, osMajor),
  ];
}

export function prototypeStringsFallbackNotes(
  spec: PrototypeSpec,
  locale?: string,
): PrototypePlatformNote[] {
  if (locale === undefined || !spec.strings) {
    return [];
  }
  const keys = prototypeStringsFallbackKeys(spec, locale);
  return keys.length
    ? [
        {
          platform: "all",
          construct: "strings.fallback",
          effect: "substituted",
          paths: keys.slice(0, 20).map((key) => `strings.default.${key}`),
          values: keys.slice(0, 20),
          ...(keys.length > 20 ? { total: keys.length } : {}),
          detail: `Locale ${locale}: referenced keys fall through to default: ${keys.slice(0, 20).join(", ")}.`,
        },
      ]
    : [];
}
