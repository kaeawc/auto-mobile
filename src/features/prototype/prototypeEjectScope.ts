import { stringLiteral } from "./nativePrototypeTemplates";
import { resolvePrototypeDataPointer } from "./prototypeData";
import type { EjectLanguage, EjectWriter } from "./prototypeEjectWriter";
import { record, type Raw } from "./prototypeTemplate";

const PLACEHOLDER = /\{[^{}]+\}/;

const SCREEN_ACTIONS = new Set(["push", "replace"]);
const STACK_ACTIONS = new Set(["pop", "popToRoot"]);

/** A stack navigation action as a call on the generated state class, else undefined. */
function navigationCall(action: Raw | undefined, language: EjectLanguage): string | undefined {
  const type = String(action?.type);
  if (typeof action?.stack !== "string") {
    return undefined;
  }
  const stack = stringLiteral(action.stack, language);
  if (SCREEN_ACTIONS.has(type) && typeof action.screen === "string") {
    return `ui.${type}(${stack}, ${stringLiteral(action.screen, language)})`;
  }
  return STACK_ACTIONS.has(type) ? `ui.${type}(${stack})` : undefined;
}

/** What an emitter sees of one node: its fields, translated strings, actions and children. */
export class EjectScope {
  constructor(
    private readonly writer: EjectWriter,
    readonly node: Raw,
    readonly path: string,
    /** The enclosing list row's index variable, for `{index}` placeholders. */
    readonly index: string | undefined,
  ) {}

  get language(): EjectLanguage {
    return this.writer.dialect.language;
  }

  string(field: string): string | undefined {
    const value = this.node[field];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * A string literal for an authored text. `{index}` inside a list row is bound to the row
   * index; any other placeholder is kept verbatim and listed as a binding TODO.
   */
  text(value: string): string {
    const rest = this.index === undefined ? value : value.replaceAll("{index}", "");
    if (PLACEHOLDER.test(rest)) {
      this.writer.todos.push({ path: this.path, kind: "binding", type: value });
    }
    if (this.index === undefined || !value.includes("{index}")) {
      return stringLiteral(value, this.language);
    }
    // The first part stays even when empty so the expression is a string in both languages.
    const index = this.writer.dialect.indexed(this.index);
    const [first, ...parts] = value.split("{index}");
    return parts.reduce(
      (expression: string, part: string) =>
        part.length > 0
          ? `${expression} + ${index} + ${stringLiteral(part, this.language)}`
          : `${expression} + ${index}`,
      stringLiteral(first, this.language),
    );
  }

  testTag(): string | undefined {
    const tag = this.string("testTag");
    return tag === undefined ? undefined : this.text(tag);
  }

  /** Statements for an action list; stack navigation is translated, the rest become TODOs. */
  actions(field: string): string[] {
    const list = this.node[field];
    if (!Array.isArray(list)) {
      return [];
    }
    return list.map((action, i) => this.action(record(action), `${this.path}.${field}[${i}]`));
  }

  private action(action: Raw | undefined, path: string): string {
    const call = navigationCall(action, this.language);
    if (call !== undefined) {
      return call;
    }
    const type = String(action?.type);
    this.writer.todos.push({ path, kind: "action", type });
    return `/* TODO(eject): ${type.replace(/[^A-Za-z0-9_]/g, "")} action */`;
  }

  children(field = "children"): string[] {
    const list = this.node[field];
    if (Array.isArray(list)) {
      return list.flatMap((child, i) =>
        this.writer.emit(child, `${this.path}.${field}[${i}]`, this.index),
      );
    }
    return this.writer.emit(list, `${this.path}.${field}`, this.index);
  }

  /** The first child template of a list, written once per row with `index` in scope. */
  row(index: string): string[] {
    const list = this.node.children;
    const template = Array.isArray(list) ? list[0] : undefined;
    return this.writer.emit(template, `${this.path}.children[0]`, index);
  }

  /** Rows the prototype's own data had for this list, so the scaffold previews the same count. */
  rowCount(): number {
    const repeat = record(this.node.repeat);
    const path = record(repeat?.items)?.path;
    const items =
      typeof path === "string" ? resolvePrototypeDataPointer(this.writer.data, path) : [];
    this.writer.todos.push({ path: `${this.path}.repeat`, kind: "binding", type: String(path) });
    return Array.isArray(items) ? items.length : 0;
  }

  /** Registers each screen of this stack and returns `[screen name, function name]` pairs. */
  stackScreens(): [string, string][] {
    const id = this.string("id") ?? "";
    const screens = record(this.node.screens) ?? {};
    const start = this.string("start") ?? Object.keys(screens)[0] ?? "";
    this.writer.stackStarts.set(id, start);
    return Object.entries(screens).map(([name, screen]) => [
      name,
      this.writer.screen(id, name, screen, `${this.path}.screens[${JSON.stringify(name)}]`),
    ]);
  }

  literal(value: string): string {
    return stringLiteral(value, this.language);
  }
}
