import { Visitor } from "oxc-parser";
import { localBindings, parseGuardSource, resolveImportedCallee, valueImports } from "./astGuard";

// Production exported names start with register, have a nonempty middle, and end
// in Tool or Tools (registerObserveTools, registerDeviceTools, registerBarrierTools).
const REGISTRATION_NAME = /^register.+Tools?$/;
const ISOLATORS = new Set([
  "isolateToolRegistry",
  "isolateEmptyToolRegistry",
  "preserveToolRegistry",
]);

export function scanToolRegistryIsolation(file: string, source: string): { line: number }[] {
  const program = parseGuardSource(file, source);
  const imports = valueImports(file, program);
  const localBinding = localBindings(program);
  const findings: { line: number }[] = [];
  let isolated = false;
  new Visitor({
    CallExpression(node) {
      const binding = resolveImportedCallee(node.callee, imports, localBinding);
      if (!binding) {
        return;
      }
      if (binding.module === "test/helpers/withTemporaryTool" && ISOLATORS.has(binding.name)) {
        isolated = true;
      }
      if (binding.module.startsWith("src/") && REGISTRATION_NAME.test(binding.name)) {
        findings.push({ line: source.slice(0, node.start).split("\n").length });
      }
    },
  }).visit(program);
  return isolated ? [] : findings;
}
