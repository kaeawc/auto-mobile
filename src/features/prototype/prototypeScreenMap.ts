import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

/** What a map node is: where the user can be (#14125). */
export type PrototypeScreenKind = "root" | "stackScreen" | "pagerPage" | "sheet" | "dialog";

export interface PrototypeScreenMapNode {
  /** Stable id: `root`, `stack:<id>/<screen>`, `pager:<id>/<index>`, or `sheet|dialog:<id or path>`. */
  id: string;
  kind: PrototypeScreenKind;
  /** Authored spec path of the node that defines it. */
  path: string;
  /** Tab or bottom-nav label for a pager page, when one points at the pager. */
  label?: string;
  /** True for the start screen of a stack and the first page of a pager. */
  start?: true;
  /** The testTag of the node that draws the screen, matched as a real screen's identifier. */
  testTag?: string;
}

export type PrototypeScreenEdgeAction = "push" | "replace" | "pop" | "popToRoot" | "setPage";

export interface PrototypeScreenMapEdge {
  from: string;
  /** `back` for a pop, whose target is the previous screen and not known statically. */
  to: string;
  action: PrototypeScreenEdgeAction;
  /** The node whose handler runs the action: its testTag, id and visible text when it has them. */
  trigger: { path: string; testTag?: string; id?: string; label?: string };
}

export interface PrototypeScreenMap {
  nodes: PrototypeScreenMapNode[];
  edges: PrototypeScreenMapEdge[];
}

const NAV_ACTIONS: ReadonlySet<string> = new Set([
  "push",
  "replace",
  "pop",
  "popToRoot",
  "setPage",
]);
const MAX_DEPTH = 200;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const testTagOf = (value: unknown): { testTag?: string } => {
  const testTag = text(record(value)?.testTag);
  return testTag ? { testTag } : {};
};

class Builder {
  readonly nodes: PrototypeScreenMapNode[] = [];
  readonly edges: PrototypeScreenMapEdge[] = [];
  private readonly stackStart = new Map<string, string>();
  private readonly pagerLabels = new Map<string, string[]>();

  /** Pager labels come from the tabBar/bottomNav that names the pager, wherever it sits. */
  collectPagerLabels(node: Record<string, unknown>): void {
    const pager = text(node.pager);
    if (
      (node.type === "tabBar" || node.type === "bottomNav") &&
      pager &&
      Array.isArray(node.items)
    ) {
      this.pagerLabels.set(
        pager,
        node.items.map((item) => text(record(item)?.label) ?? ""),
      );
    }
  }

  addNode(node: PrototypeScreenMapNode): void {
    this.nodes.push(node);
  }

  addStack(id: string, start: string): void {
    this.stackStart.set(id, `stack:${id}/${start}`);
  }

  labelFor(pager: string, index: number): string | undefined {
    return text(this.pagerLabels.get(pager)?.[index]);
  }

  /** Records every navigation action found in the node's own fields (not its child nodes). */
  addActions(node: Record<string, unknown>, from: string, path: string): void {
    const trigger = {
      path,
      ...(text(node.testTag) ? { testTag: text(node.testTag) } : {}),
      ...(text(node.id) ? { id: text(node.id) } : {}),
      ...(text(node.text ?? node.label) ? { label: text(node.text ?? node.label) } : {}),
    };
    const children = new Set(prototypeNodeChildren(node).map((child) => child.value));
    const visit = (value: unknown, depth: number): void => {
      if (depth > MAX_DEPTH || children.has(value)) {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry) => visit(entry, depth + 1));
        return;
      }
      const object = record(value);
      if (!object) {
        return;
      }
      const type = text(object.type);
      if (type && NAV_ACTIONS.has(type)) {
        this.addEdge(object, type as PrototypeScreenEdgeAction, from, trigger);
        return;
      }
      Object.values(object).forEach((entry) => visit(entry, depth + 1));
    };
    Object.values(node).forEach((value) => visit(value, 0));
  }

  private addEdge(
    action: Record<string, unknown>,
    type: PrototypeScreenEdgeAction,
    from: string,
    trigger: PrototypeScreenMapEdge["trigger"],
  ): void {
    const stack = text(action.stack);
    const pager = text(action.pager);
    let to: string | undefined;
    if (type === "push" || type === "replace") {
      to = stack && text(action.screen) ? `stack:${stack}/${text(action.screen)}` : undefined;
    } else if (type === "pop") {
      to = "back";
    } else if (type === "popToRoot") {
      to = stack ? this.stackStart.get(stack) : undefined;
    } else if (pager) {
      // setPage with next/prev has no static target, so it names the pager's relative move.
      to = `pager:${pager}/${String(action.page)}`;
    }
    if (to !== undefined) {
      this.edges.push({ from, to, action: type, trigger });
    }
  }
}

function walk(
  builder: Builder,
  value: unknown,
  path: string,
  { screen, depth }: { screen: string; depth: number },
): void {
  const node = record(value);
  if (!node || depth > MAX_DEPTH) {
    return;
  }
  builder.addActions(node, screen, path);
  const id = text(node.id) ?? path;
  if (node.type === "bottomSheet" || node.type === "dialog") {
    builder.addNode({
      id: `${node.type === "dialog" ? "dialog" : "sheet"}:${id}`,
      kind: node.type === "dialog" ? "dialog" : "sheet",
      path,
      ...testTagOf(node),
    });
  }
  if (node.type === "stack" && record(node.screens)) {
    for (const [name, child] of Object.entries(record(node.screens)!)) {
      const screenId = `stack:${id}/${name}`;
      builder.addNode({
        id: screenId,
        kind: "stackScreen",
        path: `${path}.screens[${JSON.stringify(name)}]`,
        ...(name === node.start ? { start: true as const } : {}),
        ...testTagOf(child),
      });
      walk(builder, child, `${path}.screens[${JSON.stringify(name)}]`, {
        screen: screenId,
        depth: depth + 1,
      });
    }
    return;
  }
  const children = prototypeNodeChildren(node);
  children.forEach((child, index) => {
    if (node.type === "pager" && child.suffix.startsWith(".children[")) {
      const pageId = `pager:${id}/${index}`;
      const label = builder.labelFor(id, index);
      builder.addNode({
        id: pageId,
        kind: "pagerPage",
        path: `${path}${child.suffix}`,
        ...(label ? { label } : {}),
        ...(index === 0 ? { start: true as const } : {}),
        ...testTagOf(child.value),
      });
      walk(builder, child.value, `${path}${child.suffix}`, { screen: pageId, depth: depth + 1 });
    } else {
      walk(builder, child.value, `${path}${child.suffix}`, { screen, depth: depth + 1 });
    }
  });
}

function registerStatics(builder: Builder, value: unknown, depth: number): void {
  const node = record(value);
  if (!node || depth > MAX_DEPTH) {
    return;
  }
  builder.collectPagerLabels(node);
  if (node.type === "stack" && text(node.id) && text(node.start)) {
    builder.addStack(text(node.id)!, text(node.start)!);
  }
  prototypeNodeChildren(node).forEach((child) => registerStatics(builder, child.value, depth + 1));
}

/**
 * Static screen map of a prototype spec: stack screens, pager pages, sheets and dialogs as
 * nodes, and push/replace/pop/popToRoot/setPage actions as edges, each tagged with the node that
 * triggers it. Targets that depend on runtime state (a `next` page, a pop's previous screen) are
 * reported as authored. Host-only: needs no device.
 */
export function buildPrototypeScreenMap(spec: unknown): PrototypeScreenMap {
  const builder = new Builder();
  const roots = prototypeSpecNodeRoots(spec);
  roots.forEach((root) => registerStatics(builder, root.node, 0));
  builder.addNode({ id: "root", kind: "root", path: "root" });
  roots.forEach((root) => walk(builder, root.node, root.path, { screen: "root", depth: 0 }));
  return { nodes: builder.nodes, edges: builder.edges };
}

const mermaidId = (id: string): string => `n_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
const mermaidText = (value: string): string => value.replace(/["\r\n|]/g, " ");

/** Mermaid flowchart of the map, ready for a README or design doc. */
export function prototypeScreenMapMermaid(map: PrototypeScreenMap): string {
  const lines = ["flowchart TD"];
  for (const node of map.nodes) {
    const label = mermaidText(node.label ? `${node.id} (${node.label})` : node.id);
    lines.push(`  ${mermaidId(node.id)}["${label}"]`);
  }
  const known = new Set(map.nodes.map((node) => node.id));
  for (const edge of map.edges) {
    const trigger =
      edge.trigger.testTag ?? edge.trigger.id ?? edge.trigger.label ?? edge.trigger.path;
    const target = edge.to;
    if (!known.has(target)) {
      lines.push(`  ${mermaidId(target)}["${mermaidText(target)}"]`);
      known.add(target);
    }
    lines.push(
      `  ${mermaidId(edge.from)} -->|"${mermaidText(`${edge.action}: ${trigger}`)}"| ${mermaidId(target)}`,
    );
  }
  return lines.join("\n");
}
