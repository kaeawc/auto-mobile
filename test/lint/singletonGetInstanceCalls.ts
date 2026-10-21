import {
  parseGuardSource,
  unwrapCallee,
  guardTextMayMatch,
  GuardVisitor as Visitor,
} from "./astGuard";

/**
 * Count `<Class>.getInstance(...)` calls per receiver name (direct, optional, computed or
 * parenthesized). Calls on anything but a plain identifier (`this.getInstance()`,
 * `a.b.getInstance()`) are not service-locator reads of a named singleton and are skipped.
 */
export function countSingletonGetInstanceCalls(file: string, source: string): Map<string, number> {
  const counts = new Map<string, number>();
  const program = parseGuardSource(file, source, guardTextMayMatch(source, "getInstance"));
  if (!program) {
    return counts;
  }
  new Visitor({
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      if (callee.type !== "MemberExpression") {
        return;
      }
      const property = callee.property;
      const isGetInstance = callee.computed
        ? property.type === "Literal" && property.value === "getInstance"
        : property.type === "Identifier" && property.name === "getInstance";
      const receiver = unwrapCallee(callee.object);
      if (isGetInstance && receiver.type === "Identifier") {
        counts.set(receiver.name, (counts.get(receiver.name) ?? 0) + 1);
      }
    },
  }).visit(program);
  return counts;
}
