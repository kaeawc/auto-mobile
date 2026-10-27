import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  buildPrototypeScreenMap,
  prototypeScreenMapMermaid,
} from "../../../src/features/prototype/prototypeScreenMap";

const fixture = (name: string): unknown =>
  JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dir, "../../fixtures/prototype-spec/valid", `${name}.json`),
      "utf8",
    ),
  );

const nav = (type: string, extra: Record<string, unknown> = {}) => [
  { type, stack: "nav", ...extra },
];

describe("buildPrototypeScreenMap", () => {
  test("stack screens, start flag and push/pop/popToRoot/replace edges with button labels", () => {
    const map = buildPrototypeScreenMap(fixture("stack-navigation"));
    expect(map.nodes.map((n) => n.id)).toEqual([
      "root",
      "stack:nav/home",
      "stack:nav/detail",
      "stack:nav/third",
    ]);
    expect(map.nodes.find((n) => n.start)?.id).toBe("stack:nav/home");
    expect(map.edges.map((e) => [e.action, e.from, e.to, e.trigger.label])).toEqual([
      ["push", "stack:nav/home", "stack:nav/detail", "push"],
      ["pop", "stack:nav/home", "back", "pop"],
      ["popToRoot", "stack:nav/home", "stack:nav/home", "popToRoot"],
      ["replace", "stack:nav/home", "stack:nav/detail", "replace"],
    ]);
  });

  test("nested stacks attribute an edge to the innermost screen and carry testTag", () => {
    const spec = {
      id: "s",
      root: {
        type: "stack",
        id: "nav",
        start: "a",
        screens: {
          a: {
            type: "button",
            label: "Go",
            testTag: "go",
            onTap: nav("push", { screen: "b" }),
          },
          b: {
            type: "stack",
            id: "inner",
            start: "x",
            screens: {
              x: { type: "button", label: "Up", onLongPress: nav("popToRoot") },
            },
          },
        },
      },
    };
    const map = buildPrototypeScreenMap(spec);
    expect(map.edges).toEqual([
      {
        from: "stack:nav/a",
        to: "stack:nav/b",
        action: "push",
        trigger: { path: 'root.screens["a"]', testTag: "go", label: "Go" },
      },
      {
        from: "stack:inner/x",
        to: "stack:nav/a",
        action: "popToRoot",
        trigger: { path: 'root.screens["b"].screens["x"]', label: "Up" },
      },
    ]);
  });

  test("tabs plus pager: pages take the tab labels and setPage edges target them", () => {
    const spec = {
      id: "t",
      root: {
        type: "column",
        children: [
          {
            type: "pager",
            id: "pg",
            children: [
              { type: "text", text: "A" },
              { type: "text", text: "B" },
            ],
          },
          {
            type: "tabBar",
            pager: "pg",
            items: [{ label: "Home" }, { label: "Search" }],
            onTap: [{ type: "setPage", pager: "pg", page: 1 }],
          },
        ],
      },
    };
    const map = buildPrototypeScreenMap(spec);
    expect(map.nodes.filter((n) => n.kind === "pagerPage")).toEqual([
      {
        id: "pager:pg/0",
        kind: "pagerPage",
        path: "root.children[0].children[0]",
        label: "Home",
        start: true,
      },
      {
        id: "pager:pg/1",
        kind: "pagerPage",
        path: "root.children[0].children[1]",
        label: "Search",
      },
    ]);
    expect(map.edges).toEqual([
      {
        from: "root",
        to: "pager:pg/1",
        action: "setPage",
        trigger: { path: "root.children[1]" },
      },
    ]);
  });

  test("sheets and dialogs are nodes", () => {
    const map = buildPrototypeScreenMap({
      id: "d",
      root: {
        type: "box",
        children: [
          {
            type: "bottomSheet",
            id: "filters",
            openWhen: { key: "k", equals: true },
            detents: [],
            child: { type: "text", text: "x" },
          },
          { type: "dialog", id: "confirm", openWhen: { key: "k", equals: true }, title: "T" },
        ],
      },
    });
    expect(map.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["root", "root"],
      ["sheet:filters", "sheet"],
      ["dialog:confirm", "dialog"],
    ]);
  });

  test("a spec with no navigation is just the root", () => {
    expect(buildPrototypeScreenMap({ id: "x", root: { type: "text", text: "hi" } })).toEqual({
      nodes: [{ id: "root", kind: "root", path: "root" }],
      edges: [],
    });
    expect(buildPrototypeScreenMap("not a spec")).toEqual({
      nodes: [{ id: "root", kind: "root", path: "root" }],
      edges: [],
    });
  });
});

describe("prototypeScreenMapMermaid", () => {
  test("renders nodes and labelled edges, with the pop target as a back node", () => {
    const mermaid = prototypeScreenMapMermaid(buildPrototypeScreenMap(fixture("stack-navigation")));
    expect(mermaid.split("\n")).toEqual([
      "flowchart TD",
      '  n_root["root"]',
      '  n_stack_nav_home["stack:nav/home"]',
      '  n_stack_nav_detail["stack:nav/detail"]',
      '  n_stack_nav_third["stack:nav/third"]',
      '  n_stack_nav_home -->|"push: push"| n_stack_nav_detail',
      '  n_back["back"]',
      '  n_stack_nav_home -->|"pop: pop"| n_back',
      '  n_stack_nav_home -->|"popToRoot: popToRoot"| n_stack_nav_home',
      '  n_stack_nav_home -->|"replace: replace"| n_stack_nav_detail',
    ]);
  });
});
