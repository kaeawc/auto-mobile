import { expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";
const check = (code: string, filename = "src/features/action/Example.ts") =>
  runRule(plugin.rules["no-raw-selector-field-read"], code, filename);
test.each([
  "function match(node: ViewHierarchyNode) { return node.text === target; }",
  'function match(node: any) { return node?.["resource-id"]; }',
  'const props = parser.extractNodeProperties(source); const id = props["resource-id"];',
  'function match(node: unknown) { const alias = node; return alias["content-desc"]; }',
  'function match(node: any) { const key = "resource-id"; return node[key]; }',
  'function match(node: any) { const {text, "resource-id": id} = node; }',
  "function match({text}: ViewHierarchyNode) { return text; }",
  "parser.traverseNode(root, item => item.text);",
  "function match(node: any) { return node.$.text; }",
])("rejects raw selector reads: %s", (code) => expect(check(code).length).toBeGreaterThan(0));
test.each([
  'function describe(element: Element) { return element["resource-id"]; }',
  "function search(options: TapOptions) { return options.text; }",
  "function match(node: SearchableEntry) { return node.label; }",
  'function match(node: SearchableEntry) { return node.textSources["content-desc"]; }',
  'function update(node: any) { node.text = "value"; }',
  'function match(node: any) { const text = "bounds"; return node[text]; }',
  "function first(node: any) { return node.bounds; } function second(node: Options) { return node.text; }",
])("permits non-raw reads and writes: %s", (code) => expect(check(code)).toEqual([]));
test("scope covers debug/server but excludes canonical utility and tests", () => {
  const code = "function match(node:any) { return node.text; }";
  expect(check(code, "src/features/debug/Search.ts")).toHaveLength(1);
  expect(check(code, "src/server/tool.ts")).toHaveLength(1);
  expect(check(code, "src/features/utility/SearchableNode.ts")).toEqual([]);
  expect(check(code, "test/features/action/Test.ts")).toEqual([]);
});
test("destructuring assignment and nested raw attributes cannot bypass enforcement", () => {
  expect(check("function match(node:any) { let text; ({text} = node); }")).toHaveLength(1);
  expect(check("function match(node:any) { const {$:{text}} = node; }")).toHaveLength(1);
  expect(check('function match(node:any) { node.text += "suffix"; }')).toHaveLength(1);
});
test("renaming raw parameters and casting aliases cannot bypass enforcement", () => {
  expect(check("function match(value:unknown) { return (value as Element).text; }")).toHaveLength(
    1,
  );
  expect(
    check(
      "function match(value:ViewHierarchyNode) { const key = `resource-id`; return value[key]; }",
    ),
  ).toHaveLength(1);
});
