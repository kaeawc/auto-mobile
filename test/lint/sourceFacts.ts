import { Visitor, type Expression, type Program } from "oxc-parser";
import { unwrapCallee } from "./astGuard";

/** Syntactic facts about one parsed module, for guards that must not read source text. */
export interface SourceFacts {
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

export function collectSourceFacts(program: Program): SourceFacts {
  const facts: SourceFacts = {
    moduleSpecifiers: [],
    importedNames: [],
    declaredNames: [],
    calledNames: [],
    typeofComparisons: [],
  };
  const addDeclared = (id: { type: string; name?: string } | null | undefined) => {
    if (id?.type === "Identifier" && id.name) {
      facts.declaredNames.push(id.name);
    }
  };
  new Visitor({
    ImportDeclaration(node) {
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
      if (node.moduleReference.type === "TSExternalModuleReference") {
        const specifier = stringValue(node.moduleReference.expression);
        if (specifier) {
          facts.moduleSpecifiers.push(specifier);
        }
      }
    },
    ExportAllDeclaration(node) {
      facts.moduleSpecifiers.push(node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (node.source) {
        facts.moduleSpecifiers.push(node.source.value);
      }
    },
    ImportExpression(node) {
      const specifier = stringValue(node.source);
      if (specifier) {
        facts.moduleSpecifiers.push(specifier);
      }
    },
    CallExpression(node) {
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
      addDeclared(node.id);
    },
    FunctionDeclaration(node) {
      addDeclared(node.id);
    },
    ClassDeclaration(node) {
      addDeclared(node.id);
    },
    BinaryExpression(node) {
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
