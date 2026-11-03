import { isEjectScaffoldType, type EjectScaffoldType } from "./prototypeEjectMapping";
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

/** `open`, the body one level in, then `close`. */
export function block(open: string, body: readonly string[], close = "}"): string[] {
  return [open, ...indent(body), close];
}

function pascal(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return /^[A-Za-z]/.test(name) ? name : `S${name}`;
}

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
      return this.dialect.emitters[type](raw, scope);
    }
    this.todos.push({ path, kind: "node", type: String(type) });
    return this.dialect.todoStub(raw, scope, scope.children());
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
