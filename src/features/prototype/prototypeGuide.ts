import {
  PROTOTYPE_PLATFORM_DIFFERENCES,
  PROTOTYPE_SEARCH_BAR_PLATFORM_DIFFERENCES,
} from "./prototypePlatformNotes";
import iconSymbols from "../../../schemas/prototype-ios-icon-symbols.json";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_PAGER_OPTIONS_CAPABILITY,
  PROTOTYPE_THEME_MODES_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import {
  GUIDE_APPEARANCE,
  GUIDE_CHECKS,
  GUIDE_COMPONENTS,
  GUIDE_COST,
  GUIDE_DATA,
  GUIDE_DATA_ACTIONS,
  GUIDE_EMIT_CONTEXT,
  GUIDE_DEVICE_LOOPBACK,
  GUIDE_REQUEST,
  GUIDE_ERRORS,
  GUIDE_GESTURES,
  GUIDE_INTRO,
  GUIDE_PATCH,
  GUIDE_REPEAT,
  GUIDE_STORAGE,
  GUIDE_TIMERS,
} from "./prototypeGuideProse";
import { MAX_PROTOTYPE_COMPONENT_DEPTH } from "./prototypeComponents";
import { PROTOTYPE_NATIVE_ASSET_URI, PROTOTYPE_NATIVE_URI } from "./nativePrototypeUris";

/** Resource URIs served by the prototype authoring guide. */
export const PROTOTYPE_GUIDE_URI = "automobile:prototype";
export const PROTOTYPE_ICONS_TEMPLATE = "automobile:prototype/icons{?query}";
export const PROTOTYPE_ICONS_URI = "automobile:prototype/icons";

/** Maximum icon names returned by one lookup. */
export const ICON_LOOKUP_LIMIT = 100;

interface Rule {
  kind: string;
  values?: (string | boolean)[];
  name?: string;
  item?: Rule;
  min?: number;
  max?: number;
  options?: Rule[];
}
interface Field {
  rule: Rule;
  optional: boolean;
}
interface ObjectRule {
  fields?: Record<string, Field>;
  variants?: Record<string, ObjectRule>;
}

const definitions: Record<string, ObjectRule & Rule> = contract.definitions;

function describeArray(rule: Rule): string {
  const bounded = rule.min !== undefined || rule.max !== undefined;
  const range = bounded ? ` ${rule.min ?? 0}..${rule.max ?? "n"}` : "";
  return `${describeRule(rule.item ?? { kind: "value" })}[]${range}`;
}

function describeRule(rule: Rule): string {
  switch (rule.kind) {
    case "enum":
      return (rule.values ?? []).join("|");
    case "ref":
      return rule.name ?? "ref";
    case "boundKey":
      // A state key; inside a repeat template it may also hold placeholders (see Lists).
      return "key";
    case "screenMap":
      return `screen-name → node (${rule.min}..${rule.max} entries)`;
    case "array":
      return describeArray(rule);
    case "choice":
      return (rule.options ?? []).map(describeRule).join(" or ");
    default:
      return rule.kind;
  }
}

function describeField(name: string, field: Field): string {
  return `${name}${field.optional ? "" : "*"}: ${describeRule(field.rule)}`;
}

/** Fields present, with an identical rule, in every variant: shown once, not per variant. */
function sharedFields(variants: Record<string, ObjectRule>): Map<string, Field> {
  const entries = Object.values(variants);
  const [first, ...rest] = entries;
  const shared = new Map<string, Field>();
  for (const [name, field] of Object.entries(first?.fields ?? {})) {
    const same = rest.every(
      (variant) => JSON.stringify(variant.fields?.[name]) === JSON.stringify(field),
    );
    if (same && name !== "type") {
      shared.set(name, field);
    }
  }
  return shared;
}

function variantLines(variants: Record<string, ObjectRule>, shared: Map<string, Field>): string[] {
  return Object.entries(variants).map(([type, variant]) => {
    const own = Object.entries(variant.fields ?? {})
      .filter(([name]) => name !== "type" && !shared.has(name))
      .map(([name, field]) => describeField(name, field));
    return `- \`${type}\`${own.length > 0 ? `: ${own.join(", ")}` : ""}`;
  });
}

const code = (values: readonly (string | boolean)[]): string =>
  values.map((v) => `\`${v}\``).join(", ");

function fieldRuleValues(definition: string, field: string): string[] {
  return (definitions[definition]?.fields?.[field]?.rule.values ?? []).map(String);
}

/** Markdown limits table; every value comes from the contract's `limits`. */
export function renderLimitsTable(): string {
  const rows = Object.entries(contract.limits).map(([name, value]) => `| \`${name}\` | ${value} |`);
  const actionFields = ["onTap", "onLongPress", "onDoubleTap"];
  const items = (definitions.repeat.fields?.items.rule ?? {}) as Rule;
  for (const field of actionFields) {
    const rule = (definitions.node.variants?.box.fields?.[field].rule ?? {}) as Rule;
    rows.push(`| actions per \`${field}\` | ${rule.min}..${rule.max} |`);
  }
  rows.push(`| \`repeat.items\` | ${items.min}..${items.max} |`);
  rows.push(`| \`use\` nesting (host-expanded components) | ${MAX_PROTOTYPE_COMPONENT_DEPTH} |`);
  return ["| Limit | Value |", "| --- | --- |", ...rows].join("\n");
}

function renderNodes(): string {
  const variants = definitions.node.variants ?? {};
  const shared = sharedFields(variants);
  const common = [...shared].map(([name, field]) => describeField(name, field)).join(", ");
  return [
    "## Nodes",
    "",
    "`*` marks a required field. Fields shared by every node:",
    "",
    common,
    "",
    ...variantLines(variants, shared),
    "",
    `Pager options require \`${PROTOTYPE_PAGER_OPTIONS_CAPABILITY}\` whenever any is explicitly present (including default values): \`axis\` is horizontal (default) or vertical; \`pageSpacing\` is the dp gap (default 0); \`peek: {start?, end?}\` leaves neighbouring pages visible along the main axis (default 0 on each side, \`{}\` is a no-op); \`pageSize\` is fill (default) or \`{dp}\` for fixed-size pages. Distances are finite, spacing and peek are 0..${contract.limits.MAX_PROTOTYPE_PAGER_DP}, and fixed page size is 1e-6..${contract.limits.MAX_PROTOTYPE_PAGER_DP} (\`MAX_PROTOTYPE_PAGER_DP\`). Objects are strict. On iOS dp means points. A vertical pager cannot have any vertical scroll ancestor, including a scroll with omitted axis; a horizontal scroll ancestor is allowed. Every visible page (including partly visible peek and fixed-size pages) is exposed to accessibility, observe and tapOn; Android marks the current page selected only for pagers with positive peek or a fixed pageSize; iOS marks it selected on the options path (a pager with any non-default option) and not on the legacy paged pager; plain pagers expose only the current page on both. Pages fully off-screen are not exposed.`,
    "The current page is the first fully visible page (fixed-size pages snap at Start; fill uses the usual settled page). page_changed, {page}/{pageCount}, setPage and tabBar/bottomNav pager bindings keep their meaning. Fully off-screen retained neighbours stay outside the semantics tree; stable keys and neighbour retention are unchanged. Indicator and carousel remain deferred.",
  ].join("\n");
}

function renderActions(): string {
  const variants = definitions.action.variants ?? {};
  return [
    "## Actions",
    "",
    "Used in `onTap`, `onLongPress`, `onDoubleTap` and searchBar `onSubmit` lists.",
    "",
    `Gesture fields are available only on ${code(
      Object.entries(definitions.node.variants ?? {})
        .filter(([, variant]) => variant.fields?.onLongPress !== undefined)
        .map(([type]) => type),
    )}; they require \`prototype_gestures_v1\`.`,
    "",
    ...variantLines(variants, new Map()),
  ].join("\n");
}

function renderTheme(): string {
  const roles = definitions.colorRole.values ?? [];
  return [
    "## Theme and style",
    "",
    `Theme: \`{${Object.keys(definitions.theme.fields ?? {}).join(", ")}}\`; mode is ${code(fieldRuleValues("theme", "mode"))}.`,
    "",
    `Material colour roles (a colour field takes a hex value or one of these): ${code(roles)}.`,
    "",
    `Per-mode values, refused unless the device advertises \`${PROTOTYPE_THEME_MODES_CAPABILITY}\`: every colour field (style colours, \`border.color\`, gradient stops, \`window.placement.scrim\`, a bottomSheet or drawer \`scrim\`) also takes \`{light, dark}\`, each a hex value or a role, both required; gradient stops and scrims take a role name too. \`theme.colors.light\` and \`theme.colors.dark\` are \`{<role>: hex}\` maps applied after the flat role overrides for the resolved mode. \`image.asset\` and a tabBar or bottomNav item \`image\` take \`{light: assetId, dark: assetId}\`: upload both, and a pair naming two different assets counts as two images. Prefer a role name, which already follows the mode; use a pair for a brand literal that needs a hand-picked dark value.`,
    "",
    `Text style roles (\`style.textStyle\`): ${code(fieldRuleValues("style", "textStyle"))}.`,
    "",
    `Corner shapes: ${code(fieldRuleValues("themeShapes", "corner"))}. Font families: ${code(fieldRuleValues("themeTypography", "fontFamily"))}.`,
    "",
    `Style properties: ${code(Object.keys(definitions.style.fields ?? {}))}.`,
  ].join("\n");
}

function renderIcons(): string {
  return [
    "## Icons",
    "",
    `Icon names are a closed set of ${iconNames().length} Material names; variants: ${code(contract.definitions.iconVariant.values)}.`,
    `Look names up with \`${PROTOTYPE_ICONS_URI}?query=<substring>\` (at most ${ICON_LOOKUP_LIMIT} matches per read).`,
  ].join("\n");
}

function renderNativeCode(): string {
  return [
    "## Embedding in an app",
    "",
    `Read \`${PROTOTYPE_NATIVE_URI}?id=<id>\` (optional \`platform=android|ios\`, \`deviceId\`) for a shown or saved prototype as app code: the spec, its assets, a Jetpack Compose or SwiftUI host file that renders it with the published renderer library, the library coordinate to add, and the capabilities the spec needs. Asset bytes for saved prototypes come from \`${PROTOTYPE_NATIVE_ASSET_URI}?id=<id>&assetId=<asset>\`.`,
  ].join("\n");
}

function renderWindow(): string {
  const placement = definitions.placement.variants ?? {};
  return [
    "## Window",
    "",
    `Placement types: ${code(Object.keys(placement))}. Window fields: ${Object.entries(
      definitions.window.fields ?? {},
    )
      .map(([name, field]) => describeField(name, field))
      .join(", ")}.`,
  ].join("\n");
}

export function iconNames(): readonly string[] {
  return contract.definitions.iconName.values;
}

/** Icon names containing `query` (case-insensitive), capped; an empty query matches nothing. */
export function searchIcons(query: string): { total: number; names: string[] } {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return { total: 0, names: [] };
  }
  const matches = iconNames().filter((name) => name.includes(needle));
  return { total: matches.length, names: matches.slice(0, ICON_LOOKUP_LIMIT) };
}

function renderPlatformDifferences(): string {
  return [
    "## Platform differences",
    "",
    `iOS draws SF Symbols: ${Object.keys(iconSymbols.mapped).length} of ${contract.definitions.iconName.values.length} contract names are mapped in schemas/prototype-ios-icon-symbols.json. Unmapped names draw a placeholder symbol. Agents advertise prototype_icon_sf_symbols_v1; older agents should be relaunched with a current agent.`,
    'With no variant, iOS draws the name\'s default SF Symbol, which is often the outline form; pass `variant: "filled"` on an `icon` node for the closest match to Android where the table has a filled form.',
    "",
    "- `icon.name`: unmapped names draw a placeholder; a successful show lists affected paths under `platformNotes`. Material parity remains a future option behind `prototype_icon_set_material_v1`.",
    "- `icon.variant`: filled/outlined map where a form exists; rounded/sharp/twoTone and forms absent from the table draw the default symbol. A successful show lists affected paths under `platformNotes`. Material parity remains a future option behind `prototype_icon_variant_v1`.",
    ...PROTOTYPE_PLATFORM_DIFFERENCES.filter(({ construct }) => !construct.startsWith("icon.")).map(
      ({ construct, platform, effect, capability, detail }) =>
        `- \`${construct}\`: ${platform}, ${effect}. ${detail} A successful show lists affected paths under \`platformNotes\`${capability ? `; lifted by \`${capability}\`` : ""}.`,
    ),
    ...PROTOTYPE_SEARCH_BAR_PLATFORM_DIFFERENCES.map(
      ({ construct, detail }) => `- \`${construct}\`: ${detail}`,
    ),
  ].join("\n");
}

/** The full authoring guide: hand-written prose around sections generated from the contract. */
export function renderPrototypeGuide(): string {
  return [
    GUIDE_INTRO,
    "## Limits\n\nGenerated from `schemas/prototype-spec-contract.json`.\n\n" + renderLimitsTable(),
    renderWindow(),
    renderNodes(),
    renderActions(),
    GUIDE_GESTURES,
    GUIDE_REPEAT,
    GUIDE_DATA,
    GUIDE_DATA_ACTIONS,
    GUIDE_STORAGE,
    GUIDE_TIMERS,
    GUIDE_REQUEST,
    GUIDE_EMIT_CONTEXT,
    GUIDE_CHECKS,
    GUIDE_PATCH,
    GUIDE_COMPONENTS,
    renderTheme(),
    GUIDE_APPEARANCE,
    GUIDE_CHECKS,
    GUIDE_DEVICE_LOOPBACK,
    renderIcons(),
    renderPlatformDifferences(),
    renderNativeCode(),
    GUIDE_COST,
    GUIDE_ERRORS,
  ].join("\n\n");
}
