import ts from "typescript";

/**
 * Cross-checks for the typed `requires` declaration on every tool definition (#18141).
 *
 * The registry derives `sdkEmbed`, `debugBuild` and `platform:*` from its own gates; a tool's
 * `featureFlags` option is declared by hand because the refusal lives in its handler. These pure
 * checks catch the declarations that can still drift from a runtime gate, plus a stale docs line.
 */

export const REQUIRES_META_KEY = "automobile/requires";
export const REFUSAL_HELPER = "featureFlagDisabledMessage";
/** The registry's own `debug` gate passes `tool.name`; it is the `debugBuild` requirement. */
const REGISTRY_DEBUG_FLAG = "debug";

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  android: "Android",
  ios: "iOS",
  watchos: "watchOS",
  tvos: "tvOS",
  visionos: "visionOS",
};

export interface SourceFile {
  path: string;
  text: string;
}

/** A `featureFlagDisabledMessage(flag, tool, ...)` call: the handler refuses `tool` behind `flag`. */
export interface FeatureFlagRefusalSite {
  flag: string;
  tool: string;
  location: string;
}

export interface FeatureFlagRefusalScan {
  sites: FeatureFlagRefusalSite[];
  /** Calls whose flag or tool is not a string literal, so the check cannot attribute them. */
  unresolved: string[];
}

interface DefinitionLike {
  name?: unknown;
  _meta?: Record<string, unknown>;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function literalText(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function scanFile(file: SourceFile, scan: FeatureFlagRefusalScan): void {
  if (!file.text.includes(REFUSAL_HELPER)) {
    return;
  }
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node) === REFUSAL_HELPER) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const location = `${file.path}:${line + 1}`;
      const flag = literalText(node.arguments[0]);
      const tool = literalText(node.arguments[1]);
      if (flag !== undefined && tool !== undefined) {
        scan.sites.push({ flag, tool, location });
      } else if (flag !== REGISTRY_DEBUG_FLAG) {
        scan.unresolved.push(location);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** Every feature-flag refusal call site in `files`. */
export function scanFeatureFlagRefusals(files: readonly SourceFile[]): FeatureFlagRefusalScan {
  const scan: FeatureFlagRefusalScan = { sites: [], unresolved: [] };
  for (const file of files) {
    scanFile(file, scan);
  }
  return scan;
}

/** Each definition's advertised requirements, by tool name; undefined when a tool has none listed. */
export function requirementsByTool(
  definitions: readonly unknown[],
): Map<string, string[] | undefined> {
  const byTool = new Map<string, string[] | undefined>();
  for (const definition of definitions as DefinitionLike[]) {
    if (typeof definition?.name !== "string") {
      continue;
    }
    const requires = definition._meta?.[REQUIRES_META_KEY];
    byTool.set(
      definition.name,
      Array.isArray(requires) && requires.every((entry) => typeof entry === "string")
        ? (requires as string[])
        : undefined,
    );
  }
  return byTool;
}

function featureFlagDrift(
  byTool: ReadonlyMap<string, readonly string[]>,
  scan: FeatureFlagRefusalScan,
): string[] {
  const problems = scan.unresolved.map(
    (location) =>
      `${location}: ${REFUSAL_HELPER} needs a literal flag and tool name so the tool's featureFlags can be checked`,
  );
  const refused = new Set<string>();
  for (const site of scan.sites) {
    refused.add(`${site.tool}\u0000${site.flag}`);
    const requires = byTool.get(site.tool);
    if (requires === undefined) {
      problems.push(
        `${site.location}: refusal names '${site.tool}', which is not a registered tool`,
      );
    } else if (!requires.includes(`featureFlag:${site.flag}`)) {
      problems.push(
        `${site.tool}: refused behind '${site.flag}' at ${site.location} but does not declare featureFlags: ["${site.flag}"]`,
      );
    }
  }
  for (const [tool, requires] of byTool) {
    for (const entry of requires) {
      const flag = entry.startsWith("featureFlag:")
        ? entry.slice("featureFlag:".length)
        : undefined;
      if (flag !== undefined && !refused.has(`${tool}\u0000${flag}`)) {
        problems.push(
          `${tool}: declares ${entry} but no ${REFUSAL_HELPER}("${flag}", "${tool}") refusal exists`,
        );
      }
    }
  }
  return problems;
}

function platformTableDrift(
  byTool: ReadonlyMap<string, readonly string[]>,
  gates: ToolRequirementGates,
): string[] {
  const problems: string[] = [];
  for (const [platform, tools] of Object.entries(gates.supportedTools)) {
    for (const tool of tools) {
      const requires = byTool.get(tool);
      if (requires === undefined && gates.hiddenTools.has(tool)) {
        // Hidden tools (startDevice) have no listed definition; the table still gates them.
        continue;
      }
      if (requires === undefined) {
        problems.push(
          `APPLE_PLATFORM_SUPPORTED_TOOLS.${platform} lists '${tool}', which is not a registered tool`,
        );
      } else if (
        requires.some((entry) => entry.startsWith("platform:")) &&
        !requires.includes(`platform:${platform}`)
      ) {
        problems.push(
          `${tool}: the platform gate admits ${platform} but the input schema's platform field refuses it`,
        );
      }
    }
  }
  return problems;
}

/**
 * Every disagreement between the advertised requirements and the runtime gates: a missing
 * declaration, a feature-flag refusal the tool does not declare (or the reverse), and an Apple
 * platform the gate admits but the schema refuses.
 */
export interface ToolRequirementGates {
  /** `APPLE_PLATFORM_SUPPORTED_TOOLS`: the non-iOS Apple platforms each tool opted in to. */
  supportedTools: Readonly<Record<string, ReadonlySet<string>>>;
  /** Registered tools hidden from discovery, so absent from the definitions. */
  hiddenTools: ReadonlySet<string>;
}

export function findToolRequirementsDrift(
  definitions: readonly unknown[],
  scan: FeatureFlagRefusalScan,
  gates: ToolRequirementGates,
): string[] {
  const declared = requirementsByTool(definitions);
  const missing = [...declared]
    .filter(([, requires]) => requires === undefined)
    .map(([tool]) => `${tool}: _meta["${REQUIRES_META_KEY}"] must be a list of requirements`);
  const byTool = new Map(
    [...declared].filter((entry): entry is [string, string[]] => entry[1] !== undefined),
  );
  return [...missing, ...featureFlagDrift(byTool, scan), ...platformTableDrift(byTool, gates)];
}

// --- docs/tools.md: Platforms and Needs cells per tool row --------------------------------------

/** The two generated columns that end every tool table. */
export const PLATFORMS_HEADER = "Platforms";
export const NEEDS_HEADER = "Needs";
/** The single column the two replaced; a table still carrying it is rewritten. */
const LEGACY_REQUIRES_HEADER = "Requires";
const NONE = "—";
/** Classes on the generated cells; the docs stylesheet and script find the tool tables by them. */
export const PLATFORMS_CELL_CLASS = "tool-platforms";
export const NEEDS_CELL_CLASS = "tool-needs";

interface KeyEntry {
  emoji: string;
  /** The requirement as written in `_meta["automobile/requires"]`. */
  entry: string;
  /** Hover text and accessible name for the emoji. */
  label: string;
  meaning: string;
}

const FEATURE_FLAG_PREFIX = "featureFlag:";

const GATE_KEY: readonly KeyEntry[] = [
  {
    emoji: "🧩",
    entry: "sdkEmbed",
    label: "sdkEmbed",
    meaning: "start the daemon with `--embedded-sdk`",
  },
  {
    emoji: "🐞",
    entry: "debugBuild",
    label: "debugBuild",
    meaning: "start the daemon with `--debug` (the `debug` feature flag)",
  },
  {
    emoji: "🚩",
    entry: `${FEATURE_FLAG_PREFIX}<key>`,
    label: "featureFlag",
    meaning:
      "some or all calls are refused while that feature flag (named beside the emoji) is off; enable it with `auto-mobile --daemon set-feature-flag <key> true`",
  },
];

const PLATFORM_KEY: Readonly<Record<string, KeyEntry>> = Object.fromEntries(
  (
    [
      ["android", "🤖"],
      ["ios", "🍎"],
      ["watchos", "⌚"],
      ["tvos", "📺"],
      ["visionos", "🥽"],
    ] as const
  ).map(([platform, emoji]) => [
    platform,
    {
      emoji,
      entry: `platform:${platform}`,
      label: PLATFORM_LABELS[platform],
      meaning: `the tool drives ${PLATFORM_LABELS[platform]} devices`,
    },
  ]),
);

function emojiSpan(emoji: string, label: string): string {
  return `<span role="img" aria-label="${label}" title="${label}">${emoji}</span>`;
}

function gateBadge(entry: string): string {
  if (entry.startsWith(FEATURE_FLAG_PREFIX)) {
    const flag = entry.slice(FEATURE_FLAG_PREFIX.length);
    return `${emojiSpan("🚩", entry)} <code>${flag}</code>`;
  }
  const key = GATE_KEY.find((gate) => gate.entry === entry);
  return key === undefined ? `<code>${entry}</code>` : emojiSpan(key.emoji, key.label);
}

function platformBadge(platform: string): string {
  const key = PLATFORM_KEY[platform];
  return key === undefined ? platform : emojiSpan(key.emoji, key.label);
}

/** The Platforms cell: an emoji per platform the tool drives, or `—` for a host-only tool. */
export function renderPlatformsCell(requires: readonly string[]): string {
  const platforms = requires
    .filter((entry) => entry.startsWith("platform:"))
    .map((entry) => platformBadge(entry.slice("platform:".length)));
  return `<span class="${PLATFORMS_CELL_CLASS}">${platforms.length > 0 ? platforms.join(" ") : NONE}</span>`;
}

/** The Needs cell: an emoji per gate (a feature flag keeps its key), or `—` when there is none. */
export function renderNeedsCell(requires: readonly string[]): string {
  const gates = requires.filter((entry) => !entry.startsWith("platform:")).map(gateBadge);
  return `<span class="${NEEDS_CELL_CLASS}">${gates.length > 0 ? gates.join(" · ") : NONE}</span>`;
}

// --- docs/tools.md: the emoji key for the Platforms and Needs columns -------------------------------------

export const REQUIRES_KEY_START = "<!-- requires-key:start -->";
export const REQUIRES_KEY_END = "<!-- requires-key:end -->";

/** The key table's rows: header first, then one row per platform emoji and per gate emoji. */
function requiresKeyRows(): string[][] {
  return [
    ["Emoji", "Column", "Requirement", "Meaning"],
    ...Object.values(PLATFORM_KEY).map((key) => [
      key.emoji,
      PLATFORMS_HEADER,
      `\`${key.entry}\``,
      key.meaning,
    ]),
    ...GATE_KEY.map((key) => [key.emoji, NEEDS_HEADER, `\`${key.entry}\``, key.meaning]),
  ];
}

/** The generated key table, unpadded (the formatter aligns it). */
export function renderRequiresKey(): string {
  const [header, ...body] = requiresKeyRows();
  return [row(header), row(header.map(() => "---")), ...body.map((values) => row(values))].join(
    "\n",
  );
}

interface KeyBlock {
  start: number;
  end: number;
}

function keyBlock(lines: readonly string[]): KeyBlock | undefined {
  const start = lines.findIndex((line) => line.trim() === REQUIRES_KEY_START);
  const end = lines.findIndex((line, index) => index > start && line.trim() === REQUIRES_KEY_END);
  return start === -1 || end === -1 ? undefined : { start, end };
}

/** Replace the lines between the key markers with the generated key table. */
export function applyRequiresKey(markdown: string): string {
  const lines = markdown.split("\n");
  const block = keyBlock(lines);
  if (block === undefined) {
    return markdown;
  }
  return [
    ...lines.slice(0, block.start + 1),
    "",
    renderRequiresKey(),
    "",
    ...lines.slice(block.end),
  ].join("\n");
}

/** Whether the key table between the markers matches the generated one (formatting-insensitive). */
export function findRequiresKeyDrift(markdown: string): string[] {
  const lines = markdown.split("\n");
  const block = keyBlock(lines);
  if (block === undefined) {
    return [`Key markers ${REQUIRES_KEY_START} / ${REQUIRES_KEY_END} are missing`];
  }
  const actual = lines
    .slice(block.start + 1, block.end)
    .filter((line) => line.startsWith("|"))
    .filter((_, index) => index !== 1)
    .map((line) => cells(line).join(" | "));
  const expected = requiresKeyRows().map((values) => values.join(" | "));
  return actual.join("\n") === expected.join("\n")
    ? []
    : ["Platforms and Needs key table differs from the generated key"];
}

function cells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function row(values: readonly string[]): string {
  return `| ${values.join(" | ")} |`;
}

function rowTool(line: string): string | undefined {
  return /<code>(\w+)<\/code>/.exec(cells(line)[0] ?? "")?.[1];
}

interface ToolTable {
  /** Line indexes of the header, the separator, and each body row. */
  header: number;
  body: number[];
}

/** Tables whose header's first cell is `Tool`: the per-tool index rows. */
function toolTables(lines: readonly string[]): ToolTable[] {
  const tables: ToolTable[] = [];
  let index = 0;
  while (index < lines.length) {
    const isHeader =
      lines[index].startsWith("|") &&
      cells(lines[index])[0] === "Tool" &&
      (lines[index + 1] ?? "").startsWith("|");
    if (!isHeader) {
      index++;
      continue;
    }
    const table: ToolTable = { header: index, body: [] };
    index += 2;
    while (index < lines.length && lines[index].startsWith("|")) {
      table.body.push(index);
      index++;
    }
    tables.push(table);
  }
  return tables;
}

/** How many trailing generated columns `header` carries: 2 (Platforms, Needs), 1 (Requires) or 0. */
function generatedColumnCount(header: readonly string[]): number {
  if (header.at(-2) === PLATFORMS_HEADER && header.at(-1) === NEEDS_HEADER) {
    return 2;
  }
  return header.at(-1) === LEGACY_REQUIRES_HEADER ? 1 : 0;
}

/** Rewrite every tool table so it ends with `Platforms` and `Needs`, filled from `requires`. */
export function applyRequirementColumns(
  markdown: string,
  requires: ReadonlyMap<string, readonly string[]>,
): string {
  const lines = markdown.split("\n");
  for (const table of toolTables(lines)) {
    const header = cells(lines[table.header]);
    const generated = generatedColumnCount(header);
    const kept = header.slice(0, header.length - generated);
    lines[table.header] = row([...kept, PLATFORMS_HEADER, NEEDS_HEADER]);
    lines[table.header + 1] = row(Array.from({ length: kept.length + 2 }, () => "---"));
    for (const index of table.body) {
      const values = cells(lines[index]);
      const keptValues = values.slice(0, values.length - generated);
      const current = generated === 2 ? values.slice(-2) : [NONE, NONE];
      const tool = rowTool(lines[index]);
      const toolRequires = tool === undefined ? undefined : requires.get(tool);
      const filled = toolRequires
        ? [renderPlatformsCell(toolRequires), renderNeedsCell(toolRequires)]
        : current;
      lines[index] = row([...keptValues, ...filled]);
    }
  }
  return lines.join("\n");
}

/** Tool rows whose Platforms or Needs cell disagrees with the definitions (formatting-insensitive). */
export function findDocsRequirementDrift(
  markdown: string,
  requires: ReadonlyMap<string, readonly string[]>,
): string[] {
  const lines = markdown.split("\n");
  const problems: string[] = [];
  for (const table of toolTables(lines)) {
    if (generatedColumnCount(cells(lines[table.header])) !== 2) {
      problems.push(
        `line ${table.header + 1}: tool table does not end with ${PLATFORMS_HEADER} and ${NEEDS_HEADER} columns`,
      );
      continue;
    }
    for (const index of table.body) {
      const tool = rowTool(lines[index]);
      const toolRequires = tool === undefined ? undefined : requires.get(tool);
      if (toolRequires === undefined) {
        continue;
      }
      const [platforms, needs] = cells(lines[index]).slice(-2);
      const expected = [renderPlatformsCell(toolRequires), renderNeedsCell(toolRequires)];
      if (platforms !== expected[0]) {
        problems.push(`${tool}: docs Platforms "${platforms}", definitions say "${expected[0]}"`);
      }
      if (needs !== expected[1]) {
        problems.push(`${tool}: docs Needs "${needs}", definitions say "${expected[1]}"`);
      }
    }
  }
  return problems;
}

/** Each of `tools` that no tool table row in `markdown` names: a tool page must carry its row. */
export function findMissingToolRows(markdown: string, tools: readonly string[]): string[] {
  const lines = markdown.split("\n");
  const listed = new Set(
    toolTables(lines).flatMap((table) => table.body.map((index) => rowTool(lines[index]))),
  );
  return tools
    .filter((tool) => !listed.has(tool))
    .map(
      (tool) => `${tool}: page has no \`| Tool | What it does | Platforms | Needs |\` row for it`,
    );
}
