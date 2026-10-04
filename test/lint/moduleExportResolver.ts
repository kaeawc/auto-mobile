import path, { type PlatformPath } from "node:path";
import ts from "typescript";

type ImportedBinding = { module: string; name: string };

export function toPosixPath(p: string): string {
  return p.replaceAll("\\", "/");
}

export function resolveModule(
  from: string,
  specifier: string,
  known: Set<string>,
  pathApi: Pick<PlatformPath, "dirname" | "resolve"> = path,
): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return undefined;
  }
  const resolved = pathApi.resolve(pathApi.dirname(from), specifier);
  const stem = resolved.endsWith(".js") ? resolved.slice(0, -3) : resolved;
  return [resolved, `${stem}.ts`, pathApi.resolve(stem, "index.ts")]
    .map(toPosixPath)
    .find((candidate) => known.has(candidate));
}

/** Resolve only supplied relative modules; never execute imports or consult the filesystem. */
export function moduleExportResolver(files: ts.SourceFile[]) {
  const known = new Set(files.map((file) => toPosixPath(file.fileName)));
  const imports = new Map<string, Map<string, ImportedBinding>>();
  const namespaces = new Map<string, Map<string, string>>();
  const bindings = new Map<string, Map<string, ts.Expression>>();
  const exports = new Map<string, Map<string, ImportedBinding>>();
  const stars = new Map<string, string[]>();
  for (const file of files) {
    const fileName = toPosixPath(file.fileName);
    const imported = new Map<string, ImportedBinding>();
    const namespace = new Map<string, string>();
    const local = new Map<string, ts.Expression>();
    const exported = new Map<string, ImportedBinding>();
    const wildcard: string[] = [];
    imports.set(fileName, imported);
    namespaces.set(fileName, namespace);
    bindings.set(fileName, local);
    exports.set(fileName, exported);
    stars.set(fileName, wildcard);
    for (const node of file.statements) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const entry of named.elements) {
            imported.set(entry.name.text, {
              module: node.moduleSpecifier.text,
              name: (entry.propertyName ?? entry.name).text,
            });
          }
        } else if (named && ts.isNamespaceImport(named)) {
          namespace.set(named.name.text, node.moduleSpecifier.text);
        }
      }
      if (ts.isVariableStatement(node)) {
        for (const entry of node.declarationList.declarations) {
          if (ts.isIdentifier(entry.name) && entry.initializer) {
            local.set(entry.name.text, entry.initializer);
            if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
              exported.set(entry.name.text, { module: "", name: entry.name.text });
            }
          }
        }
      }
      if (ts.isExportDeclaration(node)) {
        const module =
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : "";
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const entry of node.exportClause.elements) {
            exported.set(entry.name.text, {
              module,
              name: (entry.propertyName ?? entry.name).text,
            });
          }
        } else if (!node.exportClause && module) {
          wildcard.push(module);
        }
      }
    }
  }
  const exportedValue = (
    path: string | undefined,
    name: string,
    depth = 0,
  ): ts.Expression | undefined => {
    if (!path || depth > 12) {
      return undefined;
    }
    const entry = exports.get(path)?.get(name);
    if (entry) {
      if (entry.module) {
        return exportedValue(resolveModule(path, entry.module, known), entry.name, depth + 1);
      }
      const local = bindings.get(path)?.get(entry.name);
      if (local) {
        return local;
      }
      const imported = imports.get(path)?.get(entry.name);
      return imported
        ? exportedValue(resolveModule(path, imported.module, known), imported.name, depth + 1)
        : undefined;
    }
    for (const module of stars.get(path) ?? []) {
      const value = exportedValue(resolveModule(path, module, known), name, depth + 1);
      if (value) {
        return value;
      }
    }
    return undefined;
  };
  return {
    localValue(node: ts.Identifier): ts.Expression | undefined {
      return bindings.get(toPosixPath(node.getSourceFile().fileName))?.get(node.text);
    },
    importedName(node: ts.Identifier): string {
      return (
        imports.get(toPosixPath(node.getSourceFile().fileName))?.get(node.text)?.name ?? node.text
      );
    },
    importedValue(node: ts.Identifier): ts.Expression | undefined {
      const path = toPosixPath(node.getSourceFile().fileName);
      const entry = imports.get(path)?.get(node.text);
      return entry
        ? exportedValue(resolveModule(path, entry.module, known), entry.name)
        : undefined;
    },
    namespaceValue(node: ts.PropertyAccessExpression): ts.Expression | undefined {
      const path = toPosixPath(node.getSourceFile().fileName);
      const module = ts.isIdentifier(node.expression)
        ? namespaces.get(path)?.get(node.expression.text)
        : undefined;
      return module ? exportedValue(resolveModule(path, module, known), node.name.text) : undefined;
    },
  };
}
