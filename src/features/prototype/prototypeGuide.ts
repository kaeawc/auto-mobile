import contract from "../../../schemas/prototype-spec-contract.json";
import { GUIDE_COMPONENTS, GUIDE_ERRORS, GUIDE_INTRO, GUIDE_REPEAT } from "./prototypeGuideProse";
import { MAX_PROTOTYPE_COMPONENT_DEPTH } from "./prototypeComponents";

/** Resource URIs served by the prototype authoring guide. */
export const PROTOTYPE_GUIDE_URI = "automobile:prototype";
export const PROTOTYPE_ICONS_TEMPLATE = "automobile:prototype/icons{?query}";
export const PROTOTYPE_ICONS_URI = "automobile:prototype/icons";

/** Maximum icon names returned by one lookup. */
export const ICON_LOOKUP_LIMIT = 100;

interface Rule {
  kind: string;
  values?: string[];
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

const code = (values: readonly string[]): string => values.map((v) => `\`${v}\``).join(", ");

function fieldRuleValues(definition: string, field: string): string[] {
  return definitions[definition]?.fields?.[field]?.rule.values ?? [];
}

/** Markdown limits table; every value comes from the contract's `limits`. */
export function renderLimitsTable(): string {
  const rows = Object.entries(contract.limits).map(([name, value]) => `| \`${name}\` | ${value} |`);
  const onTap = (definitions.node.variants?.box.fields?.onTap.rule ?? {}) as Rule;
  const items = (definitions.repeat.fields?.items.rule ?? {}) as Rule;
  rows.push(`| actions per \`onTap\` | ${onTap.min}..${onTap.max} |`);
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
  ].join("\n");
}

function renderActions(): string {
  const variants = definitions.action.variants ?? {};
  return [
    "## Actions",
    "",
    "Used in `onTap` lists.",
    "",
    ...variantLines(variants, new Map()),
  ].join("\n");
}

function renderTheme(): string {
  const roles = (definitions.colorValue.options ?? []).find((o) => o.kind === "enum")?.values ?? [];
  return [
    "## Theme and style",
    "",
    `Theme: \`{${Object.keys(definitions.theme.fields ?? {}).join(", ")}}\`; mode is ${code(fieldRuleValues("theme", "mode"))}.`,
    "",
    `Material colour roles (a colour field takes a hex value or one of these): ${code(roles)}.`,
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

/** The full authoring guide: hand-written prose around sections generated from the contract. */
export function renderPrototypeGuide(): string {
  return [
    GUIDE_INTRO,
    "## Limits\n\nGenerated from `schemas/prototype-spec-contract.json`.\n\n" + renderLimitsTable(),
    renderWindow(),
    renderNodes(),
    renderActions(),
    GUIDE_REPEAT,
    GUIDE_COMPONENTS,
    renderTheme(),
    renderIcons(),
    GUIDE_ERRORS,
  ].join("\n\n");
}
