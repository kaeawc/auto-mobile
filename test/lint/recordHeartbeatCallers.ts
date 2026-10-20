import {
  parseGuardSource,
  unwrapCallee,
  guardTextMayMatch,
  GuardVisitor as Visitor,
} from "./astGuard";
import { type Expression, type PropertyKey } from "oxc-parser";

/** `foo`, `x.foo`, `x["foo"]` and a static template key name the same callee. */
function calleeName(callee: Expression): string | undefined {
  callee = unwrapCallee(callee);
  if (callee.type === "Identifier") {
    return callee.name;
  }
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  const property = callee.property;
  if (!callee.computed && property.type === "Identifier") {
    return property.name;
  }
  if (callee.computed && property.type === "TemplateLiteral" && property.expressions.length === 0) {
    return property.quasis[0].value.cooked ?? undefined;
  }
  return callee.computed && property.type === "Literal" && typeof property.value === "string"
    ? property.value
    : undefined;
}

/**
 * Scan source for calls of `name`: direct, optional, computed, wrapped, or through
 * `.call/.apply/.bind`. Syntax errors fail the inventory instead of silently skipping a file.
 */
function namedCallOffsets(file: string, source: string, name: string): number[] {
  const program = parseGuardSource(file, source, guardTextMayMatch(source, name));
  if (!program) {
    return [];
  }
  const offsets: number[] = [];
  new Visitor({
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      const calleeNameText = calleeName(callee);
      if (
        calleeNameText === name ||
        (callee.type === "MemberExpression" &&
          (calleeNameText === "call" || calleeNameText === "apply" || calleeNameText === "bind") &&
          calleeName(callee.object) === name)
      ) {
        offsets.push(node.start);
      }
    },
  }).visit(program);
  return offsets.sort((a, b) => a - b);
}

export function scanNamedCalls(file: string, source: string, name: string): { line: number }[] {
  return namedCallOffsets(file, source, name).map((offset) => ({
    line: source.slice(0, offset).split("\n").length,
  }));
}

export function scanRecordHeartbeatCalls(file: string, source: string): { line: number }[] {
  return scanNamedCalls(file, source, "recordHeartbeat");
}

interface NamedRange {
  name: string;
  start: number;
  end: number;
}

function keyName(node: PropertyKey): string | undefined {
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
    return node.name;
  }
  return node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

/**
 * Like {@link scanNamedCalls}, but names the innermost enclosing named function for each call
 * (a function declaration, a class method or property, or a function bound to a variable or
 * object key), or `<module>`. Keying an inventory by owner stops a sanctioned call and a
 * prohibited one from trading places inside the same file.
 */
export function scanNamedCallOwners(file: string, source: string, name: string): string[] {
  const program = parseGuardSource(file, source, guardTextMayMatch(source, name));
  if (!program) {
    return [];
  }
  const ranges: NamedRange[] = [];
  const isFunction = (node: { type?: string } | null | undefined): boolean =>
    node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
  new Visitor({
    FunctionDeclaration(node) {
      if (node.id) {
        ranges.push({ name: node.id.name, start: node.start, end: node.end });
      }
    },
    MethodDefinition(node) {
      const methodName = keyName(node.key);
      if (methodName) {
        ranges.push({ name: methodName, start: node.start, end: node.end });
      }
    },
    PropertyDefinition(node) {
      const propertyName = keyName(node.key);
      if (propertyName && isFunction(node.value)) {
        ranges.push({ name: propertyName, start: node.start, end: node.end });
      }
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && isFunction(node.init)) {
        ranges.push({ name: node.id.name, start: node.start, end: node.end });
      }
    },
    Property(node) {
      const propertyName = keyName(node.key);
      if (propertyName && isFunction(node.value)) {
        ranges.push({ name: propertyName, start: node.start, end: node.end });
      }
    },
  }).visit(program);
  return namedCallOffsets(file, source, name).map((offset) => {
    const owner = ranges
      .filter((range) => range.start <= offset && offset < range.end)
      .sort((a, b) => b.start - a.start)[0];
    return owner?.name ?? "<module>";
  });
}
