import { describe, expect, test } from "bun:test";
import {
  applyRequiresColumn,
  applyRequiresKey,
  findDocsRequiresDrift,
  findRequiresKeyDrift,
  findMissingToolRows,
  findToolRequirementsDrift,
  renderRequiresCell,
  renderRequiresKey,
  REQUIRES_KEY_END,
  REQUIRES_KEY_START,
  scanFeatureFlagRefusals,
  type FeatureFlagRefusalScan,
} from "../../scripts/lib/toolRequirementsDrift";

function definition(name: string, requires?: unknown) {
  return requires === undefined ? { name } : { name, _meta: { "automobile/requires": requires } };
}

const NO_SITES: FeatureFlagRefusalScan = { sites: [], unresolved: [] };
const NO_GATES = {
  supportedTools: { watchos: new Set<string>(), tvos: new Set<string>() },
  hiddenTools: new Set<string>(),
};

describe("scanFeatureFlagRefusals (#18141)", () => {
  test("records literal flag and tool, skips the registry debug gate, flags the rest", () => {
    const scan = scanFeatureFlagRefusals([
      {
        path: "src/a.ts",
        text: [
          `const A = featureFlagDisabledMessage("device-condition", "setDeviceState", "deviceCondition");`,
          `reasons.push(featureFlagDisabledMessage("debug", tool.name));`,
          `const C = featureFlagDisabledMessage(flag, "x");`,
        ].join("\n"),
      },
      { path: "src/b.ts", text: `const unrelated = 1;` },
      {
        path: "src/c.ts",
        text: `const D = featureFlagDisabledMessage /* gated */ ("tool-call-recording", "recordToolCalls");`,
      },
    ]);
    expect(scan.sites).toEqual([
      { flag: "device-condition", tool: "setDeviceState", location: "src/a.ts:1" },
      { flag: "tool-call-recording", tool: "recordToolCalls", location: "src/c.ts:1" },
    ]);
    expect(scan.unresolved).toEqual(["src/a.ts:3"]);
  });
});

describe("findToolRequirementsDrift (#18141)", () => {
  test("clean definitions report nothing", () => {
    const scan = {
      sites: [{ flag: "device-condition", tool: "setDeviceState", location: "src/a.ts:1" }],
      unresolved: [],
    };
    expect(
      findToolRequirementsDrift(
        [definition("setDeviceState", ["featureFlag:device-condition"]), definition("list", [])],
        scan,
        NO_GATES,
      ),
    ).toEqual([]);
  });

  test("a missing list, an undeclared refusal and an unrefused declaration all fail", () => {
    const scan = {
      sites: [
        { flag: "device-condition", tool: "setDeviceState", location: "src/a.ts:1" },
        { flag: "device-condition", tool: "ghost", location: "src/a.ts:2" },
      ],
      unresolved: ["src/a.ts:3"],
    };
    const problems = findToolRequirementsDrift(
      [
        definition("noList"),
        definition("setDeviceState", []),
        definition("recordToolCalls", ["featureFlag:tool-call-recording"]),
      ],
      scan,
      NO_GATES,
    );
    expect(problems).toHaveLength(5);
    expect(problems[0]).toStartWith("noList:");
    expect(problems.join("\n")).toContain("src/a.ts:3");
    expect(problems.join("\n")).toContain("setDeviceState: refused behind 'device-condition'");
    expect(problems.join("\n")).toContain("'ghost', which is not a registered tool");
    expect(problems.join("\n")).toContain(
      "recordToolCalls: declares featureFlag:tool-call-recording",
    );
  });

  test("an Apple platform the gate admits but the schema refuses is drift", () => {
    const gates = {
      supportedTools: { watchos: new Set(["tap", "listDevices", "startDevice", "gone"]) },
      hiddenTools: new Set(["startDevice"]),
    };
    const problems = findToolRequirementsDrift(
      [definition("tap", ["platform:android", "platform:ios"]), definition("listDevices", [])],
      NO_SITES,
      gates,
    );
    expect(problems).toEqual([
      "tap: the platform gate admits watchos but the input schema's platform field refuses it",
      "APPLE_PLATFORM_SUPPORTED_TOOLS.watchos lists 'gone', which is not a registered tool",
    ]);
  });
});

const emoji = (glyph: string, label: string) =>
  `<span role="img" aria-label="${label}" title="${label}">${glyph}</span>`;
const cell = (body: string) => `<span class="tool-requires">${body}</span>`;
const SDK = emoji("🧩", "sdkEmbed");
const DEBUG = emoji("🐞", "debugBuild");
const ANDROID = emoji("🤖", "Android");
const IOS = emoji("🍎", "iOS");
const TVOS = emoji("📺", "tvOS");
const WATCHOS = emoji("⌚", "watchOS");

describe("docs/tools.md Requires column (#18141)", () => {
  const requires = new Map<string, string[]>([
    ["observe", ["platform:android", "platform:ios", "platform:tvos"]],
    ["sqlQuery", ["sdkEmbed", "platform:android", "platform:ios"]],
    ["listDevices", []],
    ["rotateCrown", ["platform:watchos"]],
  ]);

  test("renders gates and only non-default platforms as emoji with hover text", () => {
    expect(renderRequiresCell(requires.get("observe")!)).toBe(cell(`${ANDROID} ${IOS} ${TVOS}`));
    expect(renderRequiresCell(requires.get("sqlQuery")!)).toBe(cell(SDK));
    expect(renderRequiresCell([])).toBe(cell("—"));
    expect(renderRequiresCell(requires.get("rotateCrown")!)).toBe(cell(WATCHOS));
    expect(renderRequiresCell(["debugBuild", "platform:watchos"])).toBe(
      cell(`${DEBUG} · ${WATCHOS}`),
    );
    expect(renderRequiresCell(["featureFlag:device-condition"])).toBe(
      cell(`${emoji("🚩", "featureFlag:device-condition")} <code>device-condition</code>`),
    );
  });

  test("adds the column, fills each tool row, and the check then passes", () => {
    const markdown = [
      "# Tools",
      "| Tool | What it does |",
      "| ---- | ---- |",
      "| 👁️ <code>observe</code> | Read the screen |",
      "| [<code>sqlQuery</code>](x.md) | Run SQL |",
      "| <code>unknown</code> | Not registered |",
      "",
      "| Case | Size |",
      "| --- | --- |",
      "| 41 mm | 176 |",
    ].join("\n");
    expect(findDocsRequiresDrift(markdown, requires)).toEqual([
      "line 2: tool table has no Requires column",
    ]);
    const applied = applyRequiresColumn(markdown, requires);
    expect(applied.split("\n").slice(1, 6)).toEqual([
      "| Tool | What it does | Requires |",
      "| --- | --- | --- |",
      `| 👁️ <code>observe</code> | Read the screen | ${cell(`${ANDROID} ${IOS} ${TVOS}`)} |`,
      `| [<code>sqlQuery</code>](x.md) | Run SQL | ${cell(SDK)} |`,
      "| <code>unknown</code> | Not registered | — |",
    ]);
    expect(applied.split("\n").slice(7)).toEqual(markdown.split("\n").slice(7));
    expect(findDocsRequiresDrift(applied, requires)).toEqual([]);
    expect(applyRequiresColumn(applied, requires)).toBe(applied);
  });

  test("a stale cell is reported", () => {
    const markdown = [
      "| Tool | What it does | Requires |",
      "| --- | --- | --- |",
      "| <code>sqlQuery</code> | Run SQL |   —   |",
    ].join("\n");
    expect(findDocsRequiresDrift(markdown, requires)).toEqual([
      `sqlQuery: docs say "—", definitions say "${cell(SDK)}"`,
    ]);
  });
});

describe("docs/tools.md Requires key (#18361)", () => {
  const page = (body: string) =>
    ["## Requires column", REQUIRES_KEY_START, body, REQUIRES_KEY_END, "## Next"].join("\n");

  test("key lists every gate and platform emoji", () => {
    const key = renderRequiresKey();
    expect(key.split("\n")[0]).toBe("| Emoji | Requirement | Meaning |");
    for (const glyph of ["🧩", "🐞", "🚩", "🤖", "🍎", "⌚", "📺", "🥽"]) {
      expect(key).toContain(`| ${glyph} |`);
    }
    expect(key).toContain("| `featureFlag:<key>` |");
  });

  test("missing markers, then a stale key, are reported; applying fills and is idempotent", () => {
    expect(findRequiresKeyDrift("## Requires column")).toEqual([
      `Requires key markers ${REQUIRES_KEY_START} / ${REQUIRES_KEY_END} are missing`,
    ]);
    const stale = page("| Emoji | Requirement | Meaning |\n| --- | --- | --- |\n| 🧩 | `x` | y |");
    expect(findRequiresKeyDrift(stale)).toEqual([
      "Requires key table differs from the generated key",
    ]);
    const applied = applyRequiresKey(stale);
    expect(applied).toContain(renderRequiresKey());
    expect(applied.endsWith(`${REQUIRES_KEY_END}\n## Next`)).toBe(true);
    expect(findRequiresKeyDrift(applied)).toEqual([]);
    expect(applyRequiresKey(applied)).toBe(applied);
  });

  test("padding added by the formatter is not drift", () => {
    const padded = applyRequiresKey(page(""))
      .split("\n")
      .map((line) => (line.startsWith("|") ? line.replaceAll(" | ", "   |   ") : line))
      .join("\n");
    expect(findRequiresKeyDrift(padded)).toEqual([]);
  });
});

describe("findMissingToolRows (#18140)", () => {
  test("reports each page tool without a tool table row", () => {
    const markdown = [
      "# Audits",
      "| Tool | What it does | Requires |",
      "| --- | --- | --- |",
      "| ✅ <code>accessibilityAudit</code> | Audit | — |",
      "",
      "Prose naming <code>performanceAudit</code> is not a row.",
    ].join("\n");
    expect(findMissingToolRows(markdown, ["accessibilityAudit", "performanceAudit"])).toEqual([
      "performanceAudit: page has no `| Tool | What it does | Requires |` row for it",
    ]);
  });
});
