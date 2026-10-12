import { parseSync, Visitor, type Expression } from "oxc-parser";

/** `foo`, `x.foo` and `x["foo"]` name the same callee. */
function calleeName(callee: Expression): string | undefined {
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
      if (calleeName(node.callee) === "recordHeartbeat") {
        findings.push({ line: source.slice(0, node.start).split("\n").length });
      }
    },
  }).visit(program);
  return findings.sort((a, b) => a.line - b.line);
}
