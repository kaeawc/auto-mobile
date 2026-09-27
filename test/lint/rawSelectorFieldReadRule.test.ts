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
test("validated protocol DTO bridges and request metadata are distinct from nodes", () => {
  expect(
    check(
      "function unpack(response: unknown) { const envelope = response as ToolEnvelope; return envelope.content[0].text; }",
    ),
  ).toEqual([]);
  expect(check("function target(params: {text?:unknown}) { return params.text; }")).toEqual([]);
});

test("typed capture containers preserve raw-node provenance", () => {
  expect(
    check("function match(capture: ViewHierarchyResult) { return capture.hierarchy.node.text; }"),
  ).toHaveLength(1);
  expect(
    check(
      'function match(capture: ViewHierarchyResult) { const {hierarchy} = capture; return hierarchy.node["resource-id"]; }',
    ),
  ).toHaveLength(1);
});

test.each([
  "function inspect(nodes: ViewHierarchyNode[]) { return nodes[0].text; }",
  "function inspect(nodes: Array<ViewHierarchyNode>) { return nodes[0].text; }",
  "function inspect(nodes: ReadonlyArray<ViewHierarchyNode[]>) { return nodes[0][0].text; }",
  "function inspect(nodes: Box<ViewHierarchyNode>) { return nodes.value.text; }",
])("raw container annotations cannot hide selector reads: %s", (code) => {
  expect(check(code)).toHaveLength(1);
});

test.each([
  "function inspect(node: ViewHierarchyNode, ready: boolean) { let props; if (ready) { props = node.$; } return props?.text; }",
  "function inspect(node: ViewHierarchyNode, ready: boolean) { let props; while (ready) { props = node.$; } return props?.text; }",
])("nested assignments retain outer raw provenance: %s", (code) => {
  expect(check(code)).toHaveLength(1);
});

test("block shadowing and typed containers remain isolated", () => {
  expect(
    check(
      "function inspect(node: ViewHierarchyNode, props: Options) { { const props = node.$; } return props.text; }",
    ),
  ).toEqual([]);
  expect(
    check("function inspect(nodes: ReadonlyArray<Element>) { return nodes[0].text; }"),
  ).toEqual([]);
});

test.each([
  "type RawNode = ViewHierarchyNode; function inspect(node: RawNode) { return node.text; }",
  'import type { ViewHierarchyNode as RawNode } from "./models"; function inspect(node: RawNode) { return node.text; }',
  "type RawNodes = Array<ViewHierarchyNode>; function inspect(nodes: RawNodes) { return nodes[0].text; }",
  "function getRoot(): ViewHierarchyNode { return source; } function inspect() { const node = getRoot(); return node.text; }",
  "function inspect() { return getRoot().text; } function getRoot(): ViewHierarchyNode { return source; }",
  "const getRoot = (): ViewHierarchyNode => source; function inspect() { return getRoot().text; }",
  "const getRoot: () => ViewHierarchyNode = () => source; function inspect() { return getRoot().text; }",
  "function inspect(nodes: ViewHierarchyNode[]) { const [node] = nodes; return node.text; }",
  "function inspect(nodes: ViewHierarchyNode[]) { const [...rest] = nodes; return rest[0].text; }",
  "function inspect(nodes: ViewHierarchyNode[]) { let node; [node] = nodes; return node.text; }",
])("explicit aliases, helper returns and destructuring retain raw provenance: %s", (code) => {
  expect(check(code)).toHaveLength(1);
});

test.each([
  "type Safe = Element; function inspect(node: Safe) { return node.text; }",
  "type Cycle = Cycle; function inspect(node: Cycle) { return node.text; }",
  "type Raw = ViewHierarchyNode; function inspect() { type Raw = Element; const node = value as Raw; return node.text; }",
  "function getRoot(): Element { return source; } function inspect() { return getRoot().text; }",
  "function getRoot(): ViewHierarchyNode { return source; } function inspect(getRoot: () => Element) { return getRoot().text; }",
  "function inspect(nodes: Element[]) { const [node] = nodes; return node.text; }",
])("safe aliases and local shadowing remain permitted: %s", (code) => {
  expect(check(code)).toEqual([]);
});

test.each([
  'function inspect(node: any, flag: boolean) { let key = "text"; if (flag) key = "bounds"; return node[key]; }',
  "function inspect(nodes: ViewHierarchyNode[]) { return nodes.find(node => node.text); }",
  'function inspect(nodes: ViewHierarchyNode[]) { return nodes.map(node => node["resource-id"]); }',
  'function inspect(nodes: ViewHierarchyNode[]) { return nodes.filter(node => node["content-desc"]); }',
  "function inspect(nodes: ViewHierarchyNode[]) { return nodes.find(() => true)?.text; }",
  "function getRoot(): Promise<ViewHierarchyNode> { return source; } async function inspect() { const node = await getRoot(); return node.text; }",
  "function getRoot(): Promise<ViewHierarchyNode> { return source; } async function inspect() { return (await getRoot()).text; }",
  "function inspect(nodes: ViewHierarchyNode[]) { for (const node of nodes) { return node.text; } }",
  "async function inspect(nodes: ViewHierarchyNode[]) { for await (const node of nodes) { return node.text; } }",
  "function inspect(node: ViewHierarchyNode) { const candidate = { node }; return candidate.node.text; }",
  "function inspect(candidate: {node: ViewHierarchyNode}) { return candidate.node.text; }",
])("tracks raw selector provenance through common wrappers: %s", (code) => {
  expect(check(code).length).toBeGreaterThan(0);
});

test("an unconditional key replacement removes an obsolete raw selector key", () => {
  expect(
    check('function inspect(node: any) { let key = "text"; key = "bounds"; return node[key]; }'),
  ).toEqual([]);
});

test.each([
  'function inspect(node: { [key: string]: unknown }) { return node["text"]; }',
  "function inspect(nodes: ViewHierarchyNode[]) { const node = nodes.pop(); return node?.text; }",
  "function inspect(nodes: ViewHierarchyNode[]) { const node = nodes.shift(); return node?.text; }",
  "interface Candidate { node: ViewHierarchyNode } function inspect(candidate: Candidate) { const { node } = candidate; return node.text; }",
  "function inspect(node: ViewHierarchyNode, safe: Element) { let candidate = node; function reset() { candidate = safe; } return candidate.text; }",
  "function inspect(node: ViewHierarchyNode, safe: Element) { let candidate = node; try { mayThrow(); candidate = safe; } catch {} return candidate.text; }",
])("rejects raw reads across additional provenance boundaries: %s", (code) => {
  expect(check(code).length).toBeGreaterThan(0);
});

test("closure and try flow still permit reads after an unconditional safe replacement", () => {
  expect(
    check(
      "function inspect(node: ViewHierarchyNode, safe: Element) { let candidate = node; candidate = safe; function reset() { candidate = node; } return candidate.text; }",
    ),
  ).toEqual([]);
});

test.each([
  "function inspect(node: ViewHierarchyNode & { extra: string }) { return node.text; }",
  "function inspect(nodes: readonly ViewHierarchyNode[]) { return nodes[0].text; }",
  "interface Box { node: ViewHierarchyNode } function inspect(box: Box) { return box.node.text; }",
  "function inspect(node: unknown) { return (node satisfies ViewHierarchyNode).text; }",
  "function inspect(nodes: ViewHierarchyNode[]) { return nodes.findIndex(node => !!node.text); }",
  "function inspect(nodes: ViewHierarchyNode[]) { return nodes.findLast(node => !!node.text); }",
  "function inspect(nodes: ViewHierarchyNode[]) { return nodes.sort((a, b) => a.text.localeCompare(b.text)); }",
  "function inspect(nodes: ViewHierarchyNode[]) { return nodes.toSorted((a, b) => a.text.localeCompare(b.text)); }",
])("tracks raw provenance through additional TypeScript forms: %s", (code) => {
  expect(check(code).length).toBeGreaterThan(0);
});

test("unconditional assignment replaces raw provenance while conditional assignment retains it", () => {
  expect(
    check(
      "function inspect(node: ViewHierarchyNode, safe: Element) { let candidate = node; candidate = safe; return candidate.text; }",
    ),
  ).toEqual([]);
  expect(
    check(
      "function inspect(node: ViewHierarchyNode, safe: Element, flag: boolean) { let candidate = node; if (flag) candidate = safe; return candidate.text; }",
    ),
  ).toHaveLength(1);
});

test("map transformations can return safe Elements without inheriting raw array provenance", () => {
  expect(
    check(
      "function inspect(nodes: ViewHierarchyNode[]) { const elements: Element[] = nodes.map((node): Element => toElement(node)); return elements[0].text; }",
    ),
  ).toEqual([]);
  expect(
    check(
      "function inspect(nodes: ViewHierarchyNode[]) { return nodes.map((node) => node)[0].text; }",
    ),
  ).toHaveLength(1);
});

test("sort comparators bind the second raw node", () => {
  expect(
    check(
      'function inspect(nodes: ViewHierarchyNode[]) { return nodes.sort((_a, b) => b.text.localeCompare("x")); }',
    ),
  ).toHaveLength(1);
  expect(
    check(
      'function inspect(nodes: ViewHierarchyNode[]) { return nodes.toSorted((_a, b) => b.text.localeCompare("x")); }',
    ),
  ).toHaveLength(1);
});

test("conditional switch and short-circuit assignments retain raw provenance", () => {
  expect(
    check(
      "function inspect(node: ViewHierarchyNode, safe: Element, n: number) { let candidate = node; switch (n) { case 1: candidate = safe; break; } return candidate.text; }",
    ),
  ).toHaveLength(1);
  expect(
    check(
      "function inspect(node: ViewHierarchyNode, safe: Element, flag: boolean) { let candidate = node; flag && (candidate = safe); return candidate.text; }",
    ),
  ).toHaveLength(1);
});

test("typed class methods preserve raw return provenance", () => {
  expect(
    check(
      "class Parser { inspect() { return this.getRoot().text; } getRoot(): ViewHierarchyNode { return source; } }",
    ),
  ).toHaveLength(1);
});

test("generic wrappers mark only raw-valued properties", () => {
  const code =
    "interface Envelope<T> { node: T; metadata: { text: string } } function inspect(envelope: Envelope<ViewHierarchyNode>) { return [envelope.node.text, envelope.metadata.text]; }";
  expect(check(code)).toHaveLength(1);
});
