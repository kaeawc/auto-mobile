import { type Expression, type Program } from "oxc-parser";
import { unwrapCallee, GuardVisitor as Visitor } from "./astGuard";

/** Syntactic facts about one parsed module, for guards that must not read source text. */
export interface SourceFacts {
  /** Every string literal (and substitution-free template) in the module, comments excluded. */
  stringLiterals: string[];
  /** Every module specifier: static import, re-export, `import()` and `require()`. */
  moduleSpecifiers: string[];
  /** Value imports as `exportedName@specifier`; `*` for a namespace, `default` for a default. */
  importedNames: string[];
  /** Names bound by any `const`/`let`/`var`/function/class declaration at any depth. */
  declaredNames: string[];
  /** Direct or `globalThis.`/`window.`-qualified callee names (`encodeURIComponent(...)`). */
  calledNames: string[];
  /** `typeof <obj>.<prop> === "<literal>"` comparisons, as `obj.prop===literal`. */
  typeofComparisons: string[];
  /** Property names of member calls on any receiver (`a.b.restart()` -> `restart`). */
  calledMethodNames: string[];
  /** `receiver.method` where receiver is the identifier or last property segment (`this.cfg.isX()` -> `cfg.isX`). */
  calledMembers: string[];
  /** Every identifier token, including property names (`this.daemonManager` -> `daemonManager`). */
  identifierNames: string[];
}

export interface SourceFactsOptions {
  /** Restrict the facts to the body of the class method with this name. */
  method?: string;
  /** Restrict to the source span from the start of one class method to the start of another. */
  between?: [from: string, to: string];
}

function stringValue(node: Expression): string | undefined {
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked ?? undefined;
  }
  return node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function calleeName(expression: Expression): string | undefined {
  const callee = unwrapCallee(expression);
  if (callee.type === "Identifier") {
    return callee.name;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    (callee.object.name === "globalThis" || callee.object.name === "window") &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
}

function memberPath(node: Expression): string | undefined {
  return node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.property.type === "Identifier"
    ? `${node.object.name}.${node.property.name}`
    : undefined;
}

function methodRange(program: Program, name: string): { start: number; end: number } {
  let found: { start: number; end: number } | undefined;
  new Visitor({
    MethodDefinition(node) {
      if (!found && node.key.type === "Identifier" && node.key.name === name) {
        found = { start: node.start, end: node.end };
      }
    },
  }).visit(program);
  if (!found) {
    throw new Error(`method ${name} not found`);
  }
  return found;
}

export function collectSourceFacts(
  program: Program,
  options: SourceFactsOptions = {},
): SourceFacts {
  const range = options.between
    ? {
        start: methodRange(program, options.between[0]).start,
        end: methodRange(program, options.between[1]).start,
      }
    : options.method
      ? methodRange(program, options.method)
      : undefined;
  const inScope = (node: { start: number; end: number }) =>
    !range || (node.start >= range.start && node.end <= range.end);
  const facts: SourceFacts = {
    stringLiterals: [],
    moduleSpecifiers: [],
    importedNames: [],
    declaredNames: [],
    calledNames: [],
    typeofComparisons: [],
    calledMethodNames: [],
    calledMembers: [],
    identifierNames: [],
  };
  const addDeclared = (id: { type: string; name?: string } | null | undefined) => {
    if (id?.type === "Identifier" && id.name) {
      facts.declaredNames.push(id.name);
    }
  };
  new Visitor({
    Literal(node) {
      if (typeof node.value === "string") {
        facts.stringLiterals.push(node.value);
      }
    },
    TemplateLiteral(node) {
      for (const quasi of node.quasis) {
        if (quasi.value.cooked) {
          facts.stringLiterals.push(quasi.value.cooked);
        }
      }
    },
    ImportDeclaration(node) {
      if (!inScope(node)) {
        return;
      }
      facts.moduleSpecifiers.push(node.source.value);
      if (node.importKind === "type") {
        return;
      }
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          facts.importedNames.push(`*@${node.source.value}`);
        } else if (specifier.type === "ImportDefaultSpecifier") {
          facts.importedNames.push(`default@${node.source.value}`);
        } else if (specifier.importKind !== "type") {
          const name =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          facts.importedNames.push(`${name}@${node.source.value}`);
        }
      }
    },
    TSImportEqualsDeclaration(node) {
      if (!inScope(node)) {
        return;
      }
      if (node.moduleReference.type === "TSExternalModuleReference") {
        const specifier = stringValue(node.moduleReference.expression);
        if (specifier) {
          facts.moduleSpecifiers.push(specifier);
        }
      }
    },
    ExportAllDeclaration(node) {
      if (!inScope(node)) {
        return;
      }
      facts.moduleSpecifiers.push(node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (!inScope(node)) {
        return;
      }
      if (node.source) {
        facts.moduleSpecifiers.push(node.source.value);
      }
    },
    ImportExpression(node) {
      if (!inScope(node)) {
        return;
      }
      const specifier = stringValue(node.source);
      if (specifier) {
        facts.moduleSpecifiers.push(specifier);
      }
    },
    PrivateIdentifier(node) {
      if (inScope(node)) {
        facts.identifierNames.push(node.name);
      }
    },
    Identifier(node) {
      if (inScope(node)) {
        facts.identifierNames.push(node.name);
      }
    },
    CallExpression(node) {
      if (!inScope(node)) {
        return;
      }
      const callee = unwrapCallee(node.callee);
      if (callee.type === "MemberExpression" && !callee.computed) {
        if (callee.property.type === "Identifier") {
          facts.calledMethodNames.push(callee.property.name);
          const receiver =
            callee.object.type === "Identifier"
              ? callee.object.name
              : callee.object.type === "MemberExpression" &&
                  !callee.object.computed &&
                  callee.object.property.type === "Identifier"
                ? callee.object.property.name
                : undefined;
          if (receiver) {
            facts.calledMembers.push(`${receiver}.${callee.property.name}`);
          }
        }
      }
      const name = calleeName(node.callee);
      if (name) {
        facts.calledNames.push(name);
      }
      const first = node.arguments[0];
      if (name === "require" && first && first.type !== "SpreadElement") {
        const specifier = stringValue(first);
        if (specifier) {
          facts.moduleSpecifiers.push(specifier);
        }
      }
    },
    VariableDeclarator(node) {
      if (!inScope(node)) {
        return;
      }
      addDeclared(node.id);
    },
    FunctionDeclaration(node) {
      if (!inScope(node)) {
        return;
      }
      addDeclared(node.id);
    },
    ClassDeclaration(node) {
      if (!inScope(node)) {
        return;
      }
      addDeclared(node.id);
    },
    BinaryExpression(node) {
      if (!inScope(node)) {
        return;
      }
      if (!["===", "==", "!==", "!="].includes(node.operator)) {
        return;
      }
      for (const [typeofSide, literalSide] of [
        [node.left, node.right],
        [node.right, node.left],
      ] as const) {
        const literal = stringValue(literalSide as Expression);
        if (
          typeofSide.type === "UnaryExpression" &&
          typeofSide.operator === "typeof" &&
          literal !== undefined
        ) {
          const path = memberPath(typeofSide.argument);
          if (path) {
            facts.typeofComparisons.push(`${path}===${literal}`);
          }
        }
      }
    },
  }).visit(program);
  return facts;
}
