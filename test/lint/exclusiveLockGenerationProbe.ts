import { Visitor, type Argument } from "oxc-parser";
import {
  localBindings,
  parseGuardSource,
  resolveImportedCallee,
  unwrapCallee,
  valueImports,
} from "./astGuard";

type Kind = "lock" | "migration";

function hasProbe(
  argument: Argument | undefined,
  binding: ReturnType<typeof localBindings>,
): boolean {
  if (!argument || argument.type === "SpreadElement") {
    return false;
  }
  let options = unwrapCallee(argument);
  if (options.type === "Identifier") {
    const bound = binding(options.name, options.start)?.initializer;
    if (!bound) {
      return false;
    }
    options = unwrapCallee(bound);
  }
  if (options.type !== "ObjectExpression") {
    return false;
  }
  return options.properties.some((property) => {
    if (property.type !== "Property" || property.kind !== "init") {
      return false;
    }
    const key =
      property.key.type === "Identifier" && !property.computed
        ? property.key.name
        : property.key.type === "Literal"
          ? property.key.value
          : undefined;
    const value = unwrapCallee(property.value);
    return (
      key === "ownerGeneration" && !(value.type === "Identifier" && value.name === "undefined")
    );
  });
}

export function scanExclusiveLockGenerationProbe(
  file: string,
  source: string,
): { line: number; kind: Kind; valid: boolean }[] {
  const program = parseGuardSource(file, source);
  const imports = valueImports(file, program);
  const localBinding = localBindings(program);
  const findings: { line: number; kind: Kind; valid: boolean }[] = [];
  new Visitor({
    CallExpression(node) {
      const callee = resolveImportedCallee(node.callee, imports, localBinding);
      if (callee?.module === "src/utils/fileLock" && callee.name === "tryAcquireExclusiveLock") {
        findings.push({
          line: source.slice(0, node.start).split("\n").length,
          kind: "lock",
          valid: hasProbe(node.arguments[1], localBinding),
        });
      }
    },
    NewExpression(node) {
      const callee = resolveImportedCallee(node.callee, imports, localBinding);
      // The production factory also constructs its own exported class without an import.
      const ownClass =
        file === "src/db/migrationLock.ts" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "FileMigrationLock";
      if (
        ownClass ||
        (callee?.module === "src/db/migrationLock" && callee.name === "FileMigrationLock")
      ) {
        findings.push({
          line: source.slice(0, node.start).split("\n").length,
          kind: "migration",
          valid: hasProbe(node.arguments[1], localBinding),
        });
      }
    },
  }).visit(program);
  return findings;
}
