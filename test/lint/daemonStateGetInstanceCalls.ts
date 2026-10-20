import {
  parseGuardSource,
  unwrapCallee,
  valueImports,
  guardTextMayMatch,
  GuardVisitor as Visitor,
} from "./astGuard";
import { type Expression } from "oxc-parser";

const CLASS_NAME = "DaemonState";

/** Local names bound to the class: `DaemonState`, renamed imports, namespace members and `const A = DaemonState`. */
function classMatcher(
  file: string,
  program: ReturnType<typeof parseGuardSource>,
): (node: Expression) => boolean {
  const aliases = new Set<string>([CLASS_NAME]);
  const namespaces = new Set<string>();
  for (const [local, binding] of valueImports(file, program)) {
    if (binding.name === CLASS_NAME) {
      aliases.add(local);
    } else if (binding.name === "*") {
      namespaces.add(local);
    }
  }
  const isClass = (node: Expression): boolean => {
    const target = unwrapCallee(node);
    if (target.type === "Identifier") {
      return aliases.has(target.name);
    }
    return (
      target.type === "MemberExpression" &&
      !target.computed &&
      target.property.type === "Identifier" &&
      target.property.name === CLASS_NAME &&
      unwrapCallee(target.object).type === "Identifier" &&
      namespaces.has((unwrapCallee(target.object) as { name: string }).name)
    );
  };
  // Alias chains (`const A = DaemonState; const B = A;`) resolve in declaration order.
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init && isClass(node.init)) {
        aliases.add(node.id.name);
      }
    },
  }).visit(program);
  return isClass;
}

/** Count `DaemonState.getInstance(...)` calls (direct, optional, computed, parenthesized or aliased). */
export function countDaemonStateGetInstanceCalls(file: string, source: string): number {
  const program = parseGuardSource(file, source, guardTextMayMatch(source, "DaemonState"));
  if (!program) {
    return 0;
  }
  const isClass = classMatcher(file, program);
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
      if (isGetInstance && isClass(object)) {
        count += 1;
      }
    },
  }).visit(program);
  return count;
}
