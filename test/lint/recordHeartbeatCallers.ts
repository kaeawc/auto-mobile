import { parseGuardSource, unwrapCallee } from "./astGuard";
import { Visitor, type Expression } from "oxc-parser";

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
  const program = parseGuardSource(file, source);
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
