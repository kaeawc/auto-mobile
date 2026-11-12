import { describe, expect, test } from "bun:test";
import {
  applyRequiresColumn,
  findDocsRequiresDrift,
  findToolRequirementsDrift,
  renderRequiresCell,
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

describe("docs/tools.md Requires column (#18141)", () => {
  const requires = new Map<string, string[]>([
    ["observe", ["platform:android", "platform:ios", "platform:tvos"]],
    ["sqlQuery", ["sdkEmbed", "platform:android", "platform:ios"]],
    ["listDevices", []],
    ["rotateCrown", ["platform:watchos"]],
  ]);

  test("renders gates as code and only non-default platforms", () => {
    expect(renderRequiresCell(requires.get("observe")!)).toBe("Android, iOS, tvOS");
    expect(renderRequiresCell(requires.get("sqlQuery")!)).toBe("<code>sdkEmbed</code>");
    expect(renderRequiresCell([])).toBe("—");
    expect(renderRequiresCell(requires.get("rotateCrown")!)).toBe("watchOS");
    expect(renderRequiresCell(["debugBuild", "platform:watchos"])).toBe(
      "<code>debugBuild</code> · watchOS",
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
      "| 👁️ <code>observe</code> | Read the screen | Android, iOS, tvOS |",
      "| [<code>sqlQuery</code>](x.md) | Run SQL | <code>sdkEmbed</code> |",
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
      'sqlQuery: docs say "—", definitions say "<code>sdkEmbed</code>"',
    ]);
  });
});
