import { parseGuardSource, unwrapCallee } from "./astGuard";
import { Visitor } from "oxc-parser";

/** Count `DaemonState.getInstance(...)` calls (direct, optional, computed or parenthesized). */
export function countDaemonStateGetInstanceCalls(file: string, source: string): number {
  const program = parseGuardSource(file, source);
  let count = 0;
  new Visitor({
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      if (callee.type !== "MemberExpression") {
        return;
      }
      const object = unwrapCallee(callee.object);
      const property = callee.property;
      const isGetInstance = callee.computed
        ? property.type === "Literal" && property.value === "getInstance"
        : property.type === "Identifier" && property.name === "getInstance";
      if (isGetInstance && object.type === "Identifier" && object.name === "DaemonState") {
        count += 1;
      }
    },
  }).visit(program);
  return count;
}
