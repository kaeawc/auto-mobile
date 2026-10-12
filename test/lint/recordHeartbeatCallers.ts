import { parseSync, Visitor, type Expression } from "oxc-parser";

/** Transparent syntax preserves the callee; a sequence calls its last expression. */
function unwrapCallee(callee: Expression): Expression {
  switch (callee.type) {
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
      return unwrapCallee(callee.expression);
    case "SequenceExpression":
      return unwrapCallee(callee.expressions[callee.expressions.length - 1]);
    default:
      return callee;
  }
}

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

/** Scan source only. Syntax errors fail the inventory instead of silently skipping a file. */
export function scanRecordHeartbeatCalls(file: string, source: string): { line: number }[] {
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) {
    throw new Error(`${file}: ${errors[0].message}`);
  }
  const findings: { line: number }[] = [];
  new Visitor({
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      const name = calleeName(callee);
      if (
        name === "recordHeartbeat" ||
        (callee.type === "MemberExpression" &&
          (name === "call" || name === "apply" || name === "bind") &&
          calleeName(callee.object) === "recordHeartbeat")
      ) {
        findings.push({ line: source.slice(0, node.start).split("\n").length });
      }
    },
  }).visit(program);
  return findings.sort((a, b) => a.line - b.line);
}
