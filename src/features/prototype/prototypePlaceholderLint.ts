/**
 * Advisory lint for placeholders in fields that do not bind (#15444). A repeat or state
 * placeholder in such a field is drawn literally, and the validator accepts the spec. This reads
 * the spec only and never refuses a show; findings name the spec path they apply to.
 */

import { expandPrototypeComponents } from "./prototypeComponents";
import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { mapBindableFields, record, STATE_KEY } from "./prototypeTemplate";

export interface PrototypePlaceholderFinding {
  /** The field's path in the spec, as validation errors spell it. */
  path: string;
  /** The placeholder as authored, braces included. */
  placeholder: string;
  detail: string;
}

export const MAX_PROTOTYPE_PLACEHOLDER_FINDINGS = 50;

/** User-visible string fields that may carry text; a `text` node binds its own `text` and spans. */
const TEXT_FIELDS = [
  "label",
  "text",
  "placeholder",
  "headline",
  "supportingText",
  "trailingText",
  "overline",
  "subtitle",
  "title",
] as const;

/**
 * Fields where a `{key}` state placeholder does not bind either (the guide: "Anything else,
 * including a `{key}` state placeholder ... is left untouched"). Other fields may be bound by a
 * renderer beyond the contract (`topAppBar.title` on iOS), so a state placeholder is only named
 * where the contract says it stays literal.
 */
const STATE_LITERAL_FIELDS = new Set([
  "chip.label",
  "badge.text",
  "textField.placeholder",
  "searchBar.placeholder",
]);

interface Scope {
  /** Repeat aliases of the enclosing containers; `index` is a placeholder only inside one. */
  aliases: readonly string[];
}

interface Visit {
  node: Record<string, unknown>;
  path: string;
  scope: Scope;
}

function placeholderTokens(text: string): { token: string; inner: string }[] {
  const tokens: { token: string; inner: string }[] = [];
  let cursor = text.indexOf("{");
  while (cursor >= 0) {
    const close = text.indexOf("}", cursor + 1);
    if (close < 0) {
      break;
    }
    const inner = text.slice(cursor + 1, close);
    if (inner !== "" && !inner.includes("{")) {
      tokens.push({ token: text.slice(cursor, close + 1), inner });
    }
    cursor = text.indexOf("{", close + 1);
  }
  return tokens;
}

function isRepeatPlaceholder(inner: string, scope: Scope): boolean {
  if (scope.aliases.length === 0) {
    return false;
  }
  if (inner === "index") {
    return true;
  }
  return scope.aliases.some(
    (alias) => inner.startsWith(`${alias}.`) && STATE_KEY.test(inner.slice(alias.length + 1)),
  );
}

function boundTextPaths(node: Record<string, unknown>, path: string): Set<string> {
  const bound = new Set<string>();
  mapBindableFields(node, path, (value, fieldPath, kind) => {
    if (kind === "text") {
      bound.add(fieldPath);
    }
    return value;
  });
  return bound;
}

function nodeFindings(visit: Visit, stateKeys: ReadonlySet<string>): PrototypePlaceholderFinding[] {
  const { node, path, scope } = visit;
  const type = typeof node.type === "string" ? node.type : "";
  if (type === "text") {
    return [];
  }
  const bound = boundTextPaths(node, path);
  return TEXT_FIELDS.flatMap((field) => {
    const value = node[field];
    if (typeof value !== "string") {
      return [];
    }
    const fieldPath = `${path}.${field}`;
    const name = `${type}.${field}`;
    return placeholderTokens(value).flatMap(({ token, inner }): PrototypePlaceholderFinding[] => {
      if (isRepeatPlaceholder(inner, scope) && !bound.has(fieldPath)) {
        return [
          {
            path: fieldPath,
            placeholder: token,
            detail: `${name} does not bind repeat placeholders, so ${token} is drawn literally. Use a field that binds (for example a text node) or write the text without it.`,
          },
        ];
      }
      if (stateKeys.has(inner) && STATE_LITERAL_FIELDS.has(name)) {
        return [
          {
            path: fieldPath,
            placeholder: token,
            detail: `${name} does not bind state placeholders, so ${token} is drawn literally. Only a text node reads {key} from state.`,
          },
        ];
      }
      return [];
    });
  });
}

function declaredStateKeys(spec: unknown): Set<string> {
  return new Set(Object.keys(record(record(spec)?.state) ?? {}));
}

function childScope(node: Record<string, unknown>, scope: Scope): Scope {
  const alias = record(node.repeat)?.as;
  return typeof alias === "string" ? { aliases: [...scope.aliases, alias] } : scope;
}

/** Every finding for a spec, in tree order, and how many there were before the output cap. */
export function lintPrototypePlaceholders(spec: unknown): {
  findings: PrototypePlaceholderFinding[];
  total: number;
} {
  const stateKeys = declaredStateKeys(spec);
  const findings: PrototypePlaceholderFinding[] = [];
  const pending: Visit[] = prototypeSpecNodeRoots(spec)
    .flatMap(({ node, path }) => {
      const object = record(node);
      return object ? [{ node: object, path, scope: { aliases: [] } }] : [];
    })
    .reverse();
  while (pending.length > 0) {
    const visit = pending.pop()!;
    findings.push(...nodeFindings(visit, stateKeys));
    const scope = childScope(visit.node, visit.scope);
    const children = prototypeNodeChildren(visit.node);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = record(children[index]!.value);
      if (child) {
        pending.push({ node: child, path: `${visit.path}${children[index]!.suffix}`, scope });
      }
    }
  }
  return {
    findings: findings.slice(0, MAX_PROTOTYPE_PLACEHOLDER_FINDINGS),
    total: findings.length,
  };
}

/**
 * The tool-output fields for a spec's lint: both absent when there is nothing to report. Like the
 * accessibility lint, a spec with `use` nodes is linted after component expansion and reported at
 * the authored path.
 */
export function prototypePlaceholderOutput(spec: unknown): {
  placeholderFindings?: PrototypePlaceholderFinding[];
  placeholderFindingsTotal?: number;
} {
  const expansion = expandPrototypeComponents(spec);
  const linted = expansion.success ? expansion.spec : spec;
  const locate = expansion.success ? expansion.locate : (path: string) => path;
  const { findings, total } = lintPrototypePlaceholders(linted);
  if (findings.length === 0) {
    return {};
  }
  return {
    placeholderFindings: findings.map((finding) => ({ ...finding, path: locate(finding.path) })),
    ...(total > findings.length ? { placeholderFindingsTotal: total } : {}),
  };
}
