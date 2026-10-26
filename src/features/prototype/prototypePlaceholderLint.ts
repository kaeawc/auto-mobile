/**
 * Advisory lint for placeholders that sit in a field which does not bind them (#15444). A repeat
 * `{item.field}` / `{index}`, a component `{props.field}` or a `{key}` state placeholder in
 * `chip.label`, `badge.text` or `textField.placeholder` is drawn literally on the device, while the
 * same placeholder in `button.label` binds. It reads the authored spec only and never refuses a show.
 */

import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { STATE_KEY, record } from "./prototypeTemplate";

/** Label-like string fields that no placeholder binds, per node type. */
const NON_BINDING_FIELDS: Readonly<Record<string, readonly string[]>> = {
  chip: ["label"],
  badge: ["text"],
  textField: ["placeholder"],
};

export const MAX_PROTOTYPE_PLACEHOLDER_FINDINGS = 50;

export interface PrototypePlaceholderFinding {
  /** The authored spec path of the field, such as `root.children[0].label`. */
  path: string;
  /** The placeholder as written, braces included. */
  placeholder: string;
  detail: string;
}

interface Scope {
  /** Repeat aliases of the enclosing templates. */
  aliases: readonly string[];
  /** Inside `components.<name>.root`, where `{props.<field>}` is bound. */
  component: boolean;
}

interface Visit {
  node: Record<string, unknown>;
  path: string;
  scope: Scope;
}

/** Every finding in tree order, and how many there were before the output cap. */
export function lintPrototypePlaceholders(spec: unknown): {
  findings: PrototypePlaceholderFinding[];
  total: number;
} {
  const stateKeys = new Set(Object.keys(record(record(spec)?.state) ?? {}));
  const findings: PrototypePlaceholderFinding[] = [];
  const pending: Visit[] = prototypeSpecNodeRoots(spec)
    .flatMap(({ node, path }) => {
      const object = record(node);
      return object
        ? [
            {
              node: object,
              path,
              scope: { aliases: [], component: path.startsWith("components.") },
            },
          ]
        : [];
    })
    .reverse();
  while (pending.length > 0) {
    const visit = pending.pop()!;
    findings.push(...nodeFindings(visit, stateKeys));
    const scope = childScope(visit);
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

function childScope({ node, scope }: Visit): Scope {
  const alias = record(node.repeat)?.as;
  return typeof alias === "string" ? { ...scope, aliases: [...scope.aliases, alias] } : scope;
}

function nodeFindings(visit: Visit, stateKeys: ReadonlySet<string>): PrototypePlaceholderFinding[] {
  const type = String(visit.node.type);
  return (NON_BINDING_FIELDS[type] ?? []).flatMap((field) => {
    const value = visit.node[field];
    const placeholder =
      typeof value === "string" ? firstPlaceholder(value, visit.scope, stateKeys) : undefined;
    return placeholder === undefined
      ? []
      : [
          {
            path: `${visit.path}.${field}`,
            placeholder,
            detail: `${type}.${field} does not bind placeholders, so ${placeholder} is drawn literally. Bind it in a field that does (for example button.label or a text node), or write the text without a placeholder.`,
          },
        ];
  });
}

/** The first well-formed placeholder the scope could bind in a field that binds none. */
function firstPlaceholder(
  text: string,
  scope: Scope,
  stateKeys: ReadonlySet<string>,
): string | undefined {
  for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
    if (isBindable(match[1]!, scope, stateKeys)) {
      return match[0];
    }
  }
  return undefined;
}

function isBindable(inner: string, scope: Scope, stateKeys: ReadonlySet<string>): boolean {
  if (inner === "index") {
    return scope.aliases.length > 0;
  }
  const dot = inner.indexOf(".");
  if (dot > 0) {
    const prefix = inner.slice(0, dot);
    const field = inner.slice(dot + 1);
    const known = scope.aliases.includes(prefix) || (scope.component && prefix === "props");
    return known && STATE_KEY.test(field);
  }
  return stateKeys.has(inner);
}

/** The tool-output fields for a spec's placeholder lint: both absent when nothing is found. */
export function prototypePlaceholderOutput(spec: unknown): {
  placeholderFindings?: PrototypePlaceholderFinding[];
  placeholderFindingsTotal?: number;
} {
  const { findings, total } = lintPrototypePlaceholders(spec);
  return findings.length === 0
    ? {}
    : {
        placeholderFindings: findings,
        ...(total > findings.length ? { placeholderFindingsTotal: total } : {}),
      };
}
