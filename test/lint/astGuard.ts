import { readdirSync } from "node:fs";
import path from "node:path";
import { parseSync, Visitor, type Expression, type Program, type ParamPattern } from "oxc-parser";

/** Transparent syntax preserves the callee; a sequence calls its last expression. */
export function unwrapCallee(callee: Expression): Expression {
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

export function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : typeScriptFiles(file);
    }
    return entry.name.endsWith(".ts") ? [file] : [];
  });
}

export function relativePosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Syntax errors must fail guards rather than hide a file from the inventory. */
export function parseGuardSource(file: string, source: string): Program {
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) {
    throw new Error(`${file}: ${errors[0].message}`);
  }
  return program;
}

/** Resolve relative TypeScript imports without executing a production module. */
export function importedModule(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(file.replaceAll("\\", "/")), specifier),
  );
  return resolved.endsWith(".ts") || resolved.endsWith(".js") ? resolved.slice(0, -3) : resolved;
}

/** Import bindings are resolved by their exported name, including renamed imports. */
export function valueImports(
  file: string,
  program: Program,
): Map<string, { module: string; name: string }> {
  const imports = new Map<string, { module: string; name: string }>();
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") {
      continue;
    }
    const module = importedModule(file, node.source.value);
    if (!module) {
      continue;
    }
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        imports.set(specifier.local.name, { module, name: "*" });
      } else if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
        const name =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value;
        imports.set(specifier.local.name, { module, name });
      }
    }
  }
  return imports;
}

export function resolveImportedCallee(
  expression: Expression,
  imports: ReturnType<typeof valueImports>,
  localBinding: (name: string, offset: number) => { initializer?: Expression } | undefined,
): { module: string; name: string } | undefined {
  const callee = unwrapCallee(expression);
  if (callee.type === "Identifier") {
    return localBinding(callee.name, callee.start) ? undefined : imports.get(callee.name);
  }
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") {
    return undefined;
  }
  const namespace = localBinding(callee.object.name, callee.start)
    ? undefined
    : imports.get(callee.object.name);
  if (namespace?.name !== "*") {
    return undefined;
  }
  const name =
    !callee.computed && callee.property.type === "Identifier"
      ? callee.property.name
      : callee.property.type === "Literal" && typeof callee.property.value === "string"
        ? callee.property.value
        : undefined;
  return name ? { module: namespace.module, name } : undefined;
}

function patternNames(pattern: ParamPattern): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "RestElement":
      return patternNames(pattern.argument);
    case "TSParameterProperty":
      return patternNames(pattern.parameter);
    case "ArrayPattern":
      return pattern.elements.flatMap((entry) => (entry ? patternNames(entry) : []));
    case "ObjectPattern":
      return pattern.properties.flatMap((entry) =>
        patternNames(entry.type === "RestElement" ? entry.argument : entry.value),
      );
  }
}

/** Resolve local literal bindings and import shadows in their lexical block/function. */
export function localBindings(
  program: Program,
): (name: string, offset: number) => { initializer?: Expression } | undefined {
  type Scope = {
    start: number;
    end: number;
    functionScope: boolean;
    values: Map<string, { initializer?: Expression }>;
  };
  const root: Scope = {
    start: program.start,
    end: program.end,
    functionScope: true,
    values: new Map(),
  };
  const scopes = [root];
  const stack = [root];
  const variableKinds: string[] = [];
  const enter = (node: { start: number; end: number }, functionScope = false) => {
    const scope: Scope = { start: node.start, end: node.end, functionScope, values: new Map() };
    stack.push(scope);
    scopes.push(scope);
  };
  const leave = () => {
    stack.pop();
  };
  const bind = (
    pattern: ParamPattern,
    initializer?: Expression,
    scope = stack[stack.length - 1],
  ) => {
    for (const name of patternNames(pattern)) {
      scope.values.set(name, { initializer });
    }
  };
  const enterFunction = (node: { start: number; end: number; params: ParamPattern[] }) => {
    enter(node, true);
    for (const param of node.params) {
      bind(param);
    }
  };
  new Visitor({
    BlockStatement(node) {
      enter(node);
    },
    "BlockStatement:exit": leave,
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": leave,
    FunctionExpression(node) {
      enterFunction(node);
      if (node.id) {
        bind(node.id);
      }
    },
    "FunctionExpression:exit": leave,
    FunctionDeclaration(node) {
      if (node.id) {
        bind(node.id);
      }
      enterFunction(node);
    },
    "FunctionDeclaration:exit": leave,
    ClassDeclaration(node) {
      if (node.id) {
        bind(node.id);
      }
    },
    CatchClause(node) {
      enter(node);
      if (node.param) {
        bind(node.param);
      }
    },
    "CatchClause:exit": leave,
    VariableDeclaration(node) {
      variableKinds.push(node.kind);
    },
    "VariableDeclaration:exit"() {
      variableKinds.pop();
    },
    VariableDeclarator(node) {
      const scope =
        variableKinds.at(-1) === "var"
          ? stack.findLast((entry) => entry.functionScope)!
          : stack[stack.length - 1];
      bind(node.id, node.init ?? undefined, scope);
    },
  }).visit(program);
  return (name, offset) => {
    // The innermost containing scope owns a shadow even when its value is unknown.
    const containing = scopes
      .filter((scope) => scope.start <= offset && offset < scope.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    for (const scope of containing) {
      const value = scope.values.get(name);
      if (value) {
        return value;
      }
    }
    return undefined;
  };
}
