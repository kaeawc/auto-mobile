import contract from "../../../schemas/prototype-spec-contract.json";
import { isEjectScaffoldType, type EjectScaffoldType } from "./prototypeEjectMapping";
import { prototypeNodeChildren } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";
import { EjectScope } from "./prototypeEjectScope";

/**
 * The language-neutral half of `automobile:prototype/eject` (#14129): walks a spec's node tree,
 * hands each supported node to a dialect (Compose or SwiftUI), and records everything it could
 * not translate as a TODO so the scaffold says what is still the app author's job.
 */

export type EjectLanguage = "kotlin" | "swift";

export interface EjectTodo {
  /** Spec path of the node or action, e.g. `root.children[2]`. */
  readonly path: string;
  readonly kind: "node" | "action" | "binding";
  /** The node or action type, or the unbound text for a binding. */
  readonly type: string;
}

/** One screen of a `stack`, written as its own function or view. */
export interface EjectScreen {
  readonly name: string;
  readonly body: readonly string[];
}

export type NodeEmitter = (node: Raw, scope: EjectScope) => string[];

export interface EjectDialect {
  readonly language: EjectLanguage;
  readonly emitters: Readonly<Record<EjectScaffoldType, NodeEmitter>>;
  /** A placeholder for an unsupported node that keeps its tag and its children. */
  todoStub(node: Raw, scope: EjectScope, children: string[]): string[];
  /** The list row index variable as a string operand of `+`. */
  indexed(index: string): string;
}

const INDENT = "    ";

export function indent(lines: readonly string[]): string[] {
  return lines.map((line) => (line.length > 0 ? `${INDENT}${line}` : line));
}

/**
 * Action statements on one line for an inline closure. Swift rejects a `;` after a comment-only
 * entry, so real calls are joined with `; ` and the TODO comments follow them.
 */
export function inlineStatements(actions: readonly string[]): string {
  const comment = (line: string): boolean => line.startsWith("/*");
  return [actions.filter((line) => !comment(line)).join("; "), ...actions.filter(comment)]
    .filter((part) => part.length > 0)
    .join(" ");
}

/** `open`, the body one level in, then `close`. */
export function block(open: string, body: readonly string[], close = "}"): string[] {
  return [open, ...indent(body), close];
}

function pascal(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return /^[A-Za-z]/.test(name) ? name : `S${name}`;
}

/**
 * Action-list fields of any node in the contract. The dialects translate `onTap` only; the rest
 * are reported so the scaffold never drops an action silently.
 */
const UNTRANSLATED_ACTION_FIELDS: readonly string[] = [
  ...new Set(
    Object.values(contract.definitions.node.variants).flatMap((variant) =>
      Object.entries(variant.fields)
        .filter(([, field]) => {
          const rule: { kind?: string; item?: { name?: string } } = field.rule;
          return rule.kind === "array" && rule.item?.name === "action";
        })
        .map(([name]) => name),
    ),
  ),
]
  .filter((name) => name !== "onTap")
  .sort();

/** Collects screens, TODOs and stack starts while a dialect writes one prototype. */
export class EjectWriter {
  readonly todos: EjectTodo[] = [];
  readonly screens: EjectScreen[] = [];
  readonly stackStarts = new Map<string, string>();
  readonly scaffolded = new Set<string>();
  private readonly screenNames = new Set<string>();

  constructor(
    readonly dialect: EjectDialect,
    readonly data: unknown,
    readonly prefix: string,
  ) {}

  emit(node: unknown, path: string, index?: string): string[] {
    const raw = record(node);
    if (!raw) {
      return [];
    }
    const scope = new EjectScope(this, raw, path, index);
    const type = raw.type;
    if (isEjectScaffoldType(type)) {
      this.scaffolded.add(type);
      const lines = this.dialect.emitters[type](raw, scope);
      return [...this.untranslatedActions(raw, path), ...lines];
    }
    this.todos.push({ path, kind: "node", type: String(type) });
    // Every contract child slot (children, child, screens, adaptive panes), so nested tags survive.
    const children = prototypeNodeChildren(raw).flatMap(({ value, suffix }) =>
      this.emit(value, `${path}${suffix}`, index),
    );
    return [...this.untranslatedActions(raw, path), ...this.dialect.todoStub(raw, scope, children)];
  }

  /** Reports each action outside `onTap` and leaves one comment line naming the fields. */
  private untranslatedActions(node: Raw, path: string): string[] {
    const fields = UNTRANSLATED_ACTION_FIELDS.filter((field) => Array.isArray(node[field]));
    this.todos.push(
      ...fields.flatMap((field) =>
        (node[field] as unknown[]).map((action, i) => ({
          path: `${path}.${field}[${i}]`,
          kind: "action" as const,
          type: String(record(action)?.type),
        })),
      ),
    );
    return fields.length === 0
      ? []
      : [`// TODO(eject): ${fields.join(", ")} actions at ${path} are not translated.`];
  }

  /** Writes a stack screen once and returns the function/view name that draws it. */
  screen(stack: string, name: string, node: unknown, path: string): string {
    let fn = `${this.prefix}${pascal(stack)}${pascal(name)}Screen`;
    for (let n = 2; this.screenNames.has(fn); n += 1) {
      fn = `${this.prefix}${pascal(stack)}${pascal(name)}Screen${n}`;
    }
    this.screenNames.add(fn);
    // Reserve the slot first so nested stacks keep a stable, outer-first order.
    const slot = this.screens.length;
    this.screens.push({ name: fn, body: [] });
    this.screens[slot] = { name: fn, body: this.emit(node, path) };
    return fn;
  }
}
