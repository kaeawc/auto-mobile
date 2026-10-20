import { readdirSync, readFileSync, statSync, type BigIntStats, type Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSync,
  Visitor as ParserVisitor,
  type VisitorObject,
  type Expression,
  type Program,
  type ParamPattern,
} from "oxc-parser";

export interface GuardProgramVisitor {
  visit(program: Program): void;
}

interface ActiveGuardHandlers {
  handlers?: VisitorObject;
}

// Keep this factory outside the constructor's scope: the retained callback must only close
// over the emptyable cell and its key, never the original handler or the GuardVisitor itself.
function forwardGuardHandler(active: ActiveGuardHandlers, key: keyof VisitorObject) {
  return function (this: unknown, node: unknown): void {
    const handler = active.handlers?.[key];
    if (handler) {
      Reflect.apply(handler, this, [node]);
    }
  };
}

/**
 * Oxc 0.153's enter/exit-object cache retains visitor callbacks process-wide. A guard callback
 * often captures its Program via bindings/scopes. Detach those callbacks after each traversal,
 * including throws, so only the guard's own lifetime can keep a tree alive.
 */
export class GuardVisitor implements GuardProgramVisitor {
  readonly #handlers: VisitorObject;
  readonly #active: ActiveGuardHandlers = {};
  readonly #visitor: GuardProgramVisitor;

  constructor(
    handlers: VisitorObject,
    createVisitor: (handlers: VisitorObject) => GuardProgramVisitor = (value) =>
      new ParserVisitor(value),
  ) {
    if (handlers === null || typeof handlers !== "object") {
      throw new TypeError("Visitor must be an object");
    }
    this.#handlers = handlers;
    const forwarded: VisitorObject = Object.fromEntries(
      Object.entries(handlers).map(([key, handler]) => [
        key,
        typeof handler === "function"
          ? forwardGuardHandler(this.#active, key as keyof VisitorObject)
          : handler,
      ]),
    );
    this.#visitor = createVisitor(forwarded);
  }

  visit(program: Program): void {
    const previous = this.#active.handlers;
    this.#active.handlers = this.#handlers;
    try {
      this.#visitor.visit(program);
    } finally {
      this.#active.handlers = previous;
    }
  }
}

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

// Cache data, never Programs: Oxc's materialized trees dwarf the source strings.
const syntaxCheckedSources = new Map<string, string>();
const directories = new Map<string, { version: string; entries: Dirent[] }>();
const inventories = new Map<string, { entries: Dirent[]; children: string[][]; files: string[] }>();

type GuardStatIdentity = Pick<BigIntStats, "dev" | "ino" | "mtimeNs" | "ctimeNs" | "size">;

interface GuardSourceReaderOptions {
  platform: NodeJS.Platform;
  stat: (file: string) => GuardStatIdentity;
  readFile: (file: string) => string;
}

function fileVersion(stat: GuardStatIdentity): string {
  // ctime catches same-size rewrites with restored mtimes; inode/device catch replacements.
  return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
}

export function createGuardSourceReader(options: GuardSourceReaderOptions) {
  const sources = new Map<string, { version: string | undefined; source: string }>();
  return (file: string | URL): string => {
    const absolute = path.resolve(typeof file === "string" ? file : fileURLToPath(file));
    // Windows/Bun can preserve every stat field across a same-size rewrite (#13843).
    const version = options.platform === "win32" ? undefined : fileVersion(options.stat(absolute));
    const cached = sources.get(absolute);
    if (version !== undefined && cached?.version === version) {
      return cached.source;
    }
    const source = options.readFile(absolute);
    if (cached?.source === source) {
      cached.version = version;
      return cached.source;
    }
    sources.set(absolute, { version, source });
    return source;
  };
}

export const readGuardFile = createGuardSourceReader({
  platform: process.platform,
  stat: (file) => statSync(file, { bigint: true }),
  readFile: (file) => readFileSync(file, "utf8"),
});

function directoryEntries(dir: string): Dirent[] {
  const absolute = path.resolve(dir);
  // Directory identities have the same Windows limitation. Re-list there so inventories
  // see creates/removes/renames, including changes below an unchanged root directory.
  if (process.platform === "win32") {
    return readdirSync(absolute, { withFileTypes: true });
  }
  const version = fileVersion(statSync(absolute, { bigint: true }));
  const cached = directories.get(absolute);
  if (cached?.version === version) {
    return cached.entries;
  }
  const entries = readdirSync(absolute, { withFileTypes: true });
  directories.set(absolute, { version, entries });
  return entries;
}

/** Shared listing reads for guards with different file-selection rules. */
export function guardDirectoryEntries(dir: string): Dirent[] {
  return directoryEntries(dir).slice();
}

function cachedTypeScriptFiles(dir: string): string[] {
  const entries = directoryEntries(dir);
  // Revalidate every descendant: changing a nested fixture need not change the root's mtime.
  const children = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => cachedTypeScriptFiles(path.join(dir, entry.name)));
  const cached = inventories.get(dir);
  if (cached?.entries === entries && children.every((files, i) => files === cached.children[i])) {
    return cached.files;
  }
  let child = 0;
  const files = entries.flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === "node_modules"
        ? []
        : children[child++]
      : entry.name.endsWith(".ts")
        ? [path.join(dir, entry.name)]
        : [],
  );
  inventories.set(dir, { entries, children, files });
  return files;
}

export function typeScriptFiles(dir: string): string[] {
  // Callers can sort/filter/mutate their inventory without corrupting another guard's cache.
  return cachedTypeScriptFiles(dir).slice();
}

export function relativePosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** A conservative text prefilter, never a replacement for AST findings or syntax checks. */
export function guardTextMayMatch(source: string, text: string | RegExp): boolean {
  const matches = (value: string): boolean => {
    if (typeof text === "string") {
      return value.includes(text);
    }
    if (!text.global && !text.sticky) {
      return text.test(value);
    }
    const lastIndex = text.lastIndex;
    try {
      text.lastIndex = 0;
      return text.test(value);
    } finally {
      text.lastIndex = lastIndex;
    }
  };
  if (matches(source)) {
    return true;
  }
  if (!source.includes("\\")) {
    return false;
  }
  // These encodings can hide ASCII names; let the parser decide. Identity escapes can
  // only remove a backslash. Removing every backslash also joins nonmatching fragments
  // and turns control escapes into letters: both can only overselect ASCII guard names.
  if (/\\(?:u|x|[1-9]|0\d|[\r\n\u2028\u2029])/.test(source)) {
    return true;
  }
  // The named-call scanner also accepts arbitrary keys containing controls/backslashes.
  if (typeof text === "string" && /[\\\u0000-\u001f]/.test(text)) {
    return true;
  }
  return matches(source.replaceAll("\\", ""));
}

/** Syntax errors must fail guards rather than hide a file from the inventory. */
export function parseGuardSource(
  file: string,
  source: string,
  candidate: boolean,
): Program | undefined;
export function parseGuardSource(file: string, source: string): Program;
export function parseGuardSource(
  file: string,
  source: string,
  candidate = true,
): Program | undefined {
  if (!candidate && syntaxCheckedSources.get(file) === source) {
    return undefined;
  }
  const parsed = parseSync(file, source);
  const { errors } = parsed;
  if (errors.length > 0) {
    throw new Error(`${file}: ${errors[0].message}`);
  }
  syntaxCheckedSources.set(file, source);
  // Syntax is always checked, but a conservative prefilter can avoid Oxc's lazy AST getter.
  return candidate ? parsed.program : undefined;
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
  new GuardVisitor({
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
