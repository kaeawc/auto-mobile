import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { toJSONSchema } from "zod/v4";
import type { JsonSchemaValidator } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { BootedDevice, KeyboardResult } from "../../src/models";
import type { SendKeysResult } from "../../src/features/action/SendKeys";
import { AndroidImeCatalog } from "../../src/features/action/AndroidImeCatalog";
import { InstalledImeKeySession } from "../../src/features/action/InstalledImeKeySession";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import {
  type InteractionToolDependencies,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createJSONToolResponse } from "../../src/utils/toolUtils";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { readToolResponse } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

const interactionDeps: InteractionToolDependencies = {};
isolateToolRegistry();
const device: BootedDevice = { deviceId: "fake-output-schema", name: "Fake", platform: "android" };
const validators = new Map<string, JsonSchemaValidator<unknown>>();

// Compile the same validators the SDK caches on tools/list, outside test timing.
beforeAll(() => {
  registerInteractionTools(interactionDeps);
  const provider = new AjvJsonSchemaValidator();
  for (const name of ["sendKeys", "keyboard", "openLink", "shake"]) {
    const definition = ToolRegistry.getToolDefinitions().find((tool) => tool.name === name)!;
    // Disabled tools are still registered; use their registered schema directly.
    const schema =
      definition?.outputSchema ?? toJSONSchema(ToolRegistry.getTool(name)!.outputSchema!);
    validators.set(name, provider.getValidator(schema));
  }
});
beforeEach(() => registerInteractionTools(interactionDeps));
afterEach(() => {
  delete interactionDeps.sendKeysFactory;
  delete interactionDeps.keyboardFactory;
  delete interactionDeps.openUrlFactory;
  delete interactionDeps.shakeFactory;
});

async function checkResponse(
  name: string,
  args: Record<string, unknown>,
  payload: object,
  isError?: boolean,
) {
  const tool = ToolRegistry.getTool(name)!;
  const response = readToolResponse(await tool.deviceAwareHandler!(device, args));
  expect(response.content).toEqual(createJSONToolResponse(payload).content);
  expect(response.isError).toBe(isError);
  // The SDK requires presence unless isError; it validates whenever content is present.
  expect(response.isError === true || response.structuredContent !== undefined).toBe(true);
  expect(response.structuredContent).toEqual(payload);
  expect(tool.outputSchema!.safeParse(response.structuredContent).success).toBe(true);
  expect(validators.get(name)!(response.structuredContent).valid).toBe(true);
}

for (const success of [true, false]) {
  test(`sendKeys ${success ? "success" : "failure"} preserves text and isError`, async () => {
    const capability = spyOn(
      AndroidCtrlProxyClient.prototype,
      "getSupportedCommands",
    ).mockResolvedValue(["request_insert_text"]);
    const result: SendKeysResult = {
      success,
      completedCommands: success ? 1 : 0,
      commands: [{ index: 0, action: "clear", success }],
      ...(success ? {} : { failedIndex: 0, error: "No focused input" }),
    };
    interactionDeps.sendKeysFactory = () => ({ execute: async () => result });
    try {
      await checkResponse(
        "sendKeys",
        { commands: [{ action: "clear" }] },
        {
          message: success
            ? "Executed 1 sendKeys command(s)"
            : "sendKeys stopped at command 0: No focused input",
          ...result,
        },
        success ? undefined : true,
      );
    } finally {
      capability.mockRestore();
    }
  });
  for (const action of ["detect", "open", "close"] as const) {
    test(`keyboard ${action} ${success ? "success" : "failure"} preserves text`, async () => {
      const result: KeyboardResult = {
        success,
        open: success,
        ...(success ? {} : { error: "failed" }),
      };
      interactionDeps.keyboardFactory = () => ({ execute: async () => result });
      await checkResponse("keyboard", { action }, result, success ? undefined : true);
    });
  }
}

test("keyboard exceptions still throw actionable errors", async () => {
  interactionDeps.keyboardFactory = () => ({
    execute: async () => {
      throw new Error("failed");
    },
  });
  await expect(
    ToolRegistry.getTool("keyboard")!.deviceAwareHandler!(device, { action: "detect" }),
  ).rejects.toThrow("Failed to execute keyboard detect: failed");
});

test("keyboard listProfiles preserves the catalog text", async () => {
  const catalog = {
    success: true,
    catalogId: "automobile_behavior_profiles",
    catalogVersion: 1,
    activeProfileId: "gboard",
    profiles: [
      {
        id: "gboard",
        displayName: "Gboard",
        version: 1,
        evidenceStatus: "focused_trace" as const,
        evidenceNote: "Fake catalog",
        behavior: {
          composeWords: true,
          enterStrategy: "KEY_EVENT" as const,
          backspaceStrategy: "DELETE_SURROUNDING" as const,
          recomposeOnCursorMove: false,
          recomposeOnBackspaceIntoWord: true,
          batchEdits: true,
        },
      },
    ],
  };
  const supported = spyOn(AndroidCtrlProxyClient.prototype, "supportsCommand").mockResolvedValue(
    true,
  );
  const list = spyOn(AndroidCtrlProxyClient.prototype, "listKeyboardProfiles").mockResolvedValue(
    catalog,
  );
  try {
    await checkResponse("keyboard", { action: "listProfiles" }, catalog);
  } finally {
    supported.mockRestore();
    list.mockRestore();
  }
});

test("keyboard setProfile preserves the profile text", async () => {
  const result = { success: true, activeProfileId: "gboard", previousProfileId: "direct" };
  const supported = spyOn(AndroidCtrlProxyClient.prototype, "supportsCommand").mockResolvedValue(
    true,
  );
  const select = spyOn(AndroidCtrlProxyClient.prototype, "setKeyboardProfile").mockResolvedValue(
    result,
  );
  try {
    await checkResponse(
      "keyboard",
      { action: "setProfile", profile: "gboard" },
      {
        activeProfileId: result.activeProfileId,
        previousProfileId: result.previousProfileId,
      },
    );
  } finally {
    supported.mockRestore();
    select.mockRestore();
  }
});

for (const action of ["listImes", "setIme", "tapImeKey"] as const) {
  test(`keyboard ${action} preserves installed IME text`, async () => {
    const catalog = { activeImeId: "com.example/.Ime", installed: [] };
    const keyResult: Awaited<ReturnType<InstalledImeKeySession["tapKey"]>> = {
      imeId: catalog.activeImeId,
      key: "A",
      x: 1,
      y: 2,
      editorVerification: { status: "changed" },
      backend: "installedIme",
      capability: "visibleKeyTap",
      keyboard: { component: catalog.activeImeId, package: "com.example" },
    };
    const adb = spyOn(defaultAdbClientFactory, "create").mockReturnValue(new FakeAdbExecutor());
    const list = spyOn(AndroidImeCatalog.prototype, "list").mockResolvedValue(catalog);
    const select = spyOn(AndroidImeCatalog.prototype, "select").mockResolvedValue(catalog);
    const tap = spyOn(InstalledImeKeySession.prototype, "tapKey").mockResolvedValue(keyResult);
    try {
      await checkResponse(
        "keyboard",
        { action, imeId: catalog.activeImeId, key: "A" },
        action === "tapImeKey" ? keyResult : catalog,
      );
    } finally {
      adb.mockRestore();
      list.mockRestore();
      select.mockRestore();
      tap.mockRestore();
    }
  });
}

for (const success of [true, false]) {
  test(`openLink ${success ? "success" : "failure"} preserves text`, async () => {
    const result = { success, url: "https://example.com", ...(success ? {} : { error: "failed" }) };
    interactionDeps.openUrlFactory = () => ({ execute: async () => result });
    await checkResponse(
      "openLink",
      { url: result.url },
      {
        message: success ? `Opened link ${result.url}` : `Failed to open ${result.url}: failed`,
        ...result,
      },
      success ? undefined : true,
    );
  });
}

for (const success of [true, false]) {
  test(`shake ${success ? "success" : "failure"} preserves text and isError`, async () => {
    const result = { success, duration: 10, intensity: 20, ...(success ? {} : { error: "busy" }) };
    interactionDeps.shakeFactory = () => ({ execute: async () => result });
    await checkResponse(
      "shake",
      { duration: 10, intensity: 20 },
      {
        message: success
          ? "Shook device for 10ms with intensity 20"
          : "Failed to shake device: busy",
        observation: undefined,
        ...result,
      },
      success ? undefined : true,
    );
  });
}

// Source contract: follow registered schema handlers, local helpers and server-module
// imports/factories. Device execution is deliberately outside this static guard.
interface SourceIndex {
  source: ts.SourceFile;
  bindings: Map<string, ts.Node>;
  imports: Map<string, { file: string; name: string }>;
  reexports: string[];
  registrations: Array<{ name: string; handler: ts.Expression; nonDeviceHandler?: ts.Expression }>;
}
const serverDirectory = path.resolve(import.meta.dir, "../../src/server");
// Handlers delegate response building to helpers that moved out of src/server
// (e.g. createProvisionDeviceResponse in deviceLifecycleCore, #12719), so imports
// are followed anywhere under src/ and the scan also indexes those helper modules.
const sourceRoot = path.resolve(import.meta.dir, "../../src");
const auditedDirectories = [serverDirectory, path.join(sourceRoot, "features/deviceLifecycle")];

function isInside(directory: string, target: string, pathApi = path): boolean {
  const relative = pathApi.relative(directory, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

function sourceKey(file: string, pathApi = path): string {
  const normalized = pathApi.normalize(file);
  // Windows glob results and resolved imports may differ in separators and case.
  return pathApi.sep === "\\" ? normalized.replaceAll("\\", "/").toLowerCase() : normalized;
}

function indexSource(
  file: string,
  source: string,
  directory = sourceRoot,
  pathApi = path,
): SourceIndex {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const index: SourceIndex = {
    source: ast,
    bindings: new Map(),
    imports: new Map(),
    reexports: [],
    registrations: [],
  };
  const lateBound = new Map<string, string>();
  const lateRegistrations: Array<{ variable: string; handler: ts.Expression }> = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      index.bindings.set(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (
        ts.isIdentifier(node.name) &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer) ||
          ts.isCallExpression(node.initializer))
      ) {
        index.bindings.set(node.name.text, node.initializer);
      }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          // A name already bound to its own initializer (e.g. a handler built inside
          // the factory being destructured) must not be rebound to the whole factory
          // call, or the audit walks every sibling handler it returns.
          if (ts.isIdentifier(element.name) && !index.bindings.has(element.name.text)) {
            index.bindings.set(element.name.text, node.initializer);
          }
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isCallExpression(node.right)
    ) {
      index.bindings.set(node.left.text, node.right);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = pathApi.resolve(pathApi.dirname(file), `${node.moduleSpecifier.text}.ts`);
      const names = node.importClause?.namedBindings;
      if (isInside(directory, target, pathApi) && names && ts.isNamedImports(names)) {
        for (const element of names.elements) {
          index.imports.set(element.name.text, {
            file: target,
            name: element.propertyName?.text ?? element.name.text,
          });
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const target = pathApi.resolve(pathApi.dirname(file), `${node.moduleSpecifier.text}.ts`);
      if (isInside(directory, target, pathApi)) {
        if (!node.exportClause) {
          index.reexports.push(target);
        } else if (ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            if (!element.isTypeOnly) {
              index.imports.set(element.name.text, {
                file: target,
                name: element.propertyName?.text ?? element.name.text,
              });
            }
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ToolRegistry" &&
      ["register", "registerDeviceAware"].includes(node.expression.name.text)
    ) {
      // The fourth argument is the bare handler or a grouped `{ handler, ...options }`
      // registration (#11835); the legacy fifth-argument options form is still read.
      const [name, , , registration, legacyOptions] = node.arguments;
      const grouped =
        registration && ts.isObjectLiteralExpression(registration) ? registration : undefined;
      const handler = grouped
        ? grouped.properties.find(
            (property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) && property.name.getText(ast) === "handler",
          )?.initializer
        : registration;
      const options = grouped ?? legacyOptions;
      if (
        name &&
        ts.isStringLiteral(name) &&
        handler &&
        options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) && property.name.getText(ast) === "outputSchema",
        )
      ) {
        // Tools registered with `shouldEnsureDevice: () => false` do their work in
        // `nonDeviceHandler`, so the audit must follow it as well as the positional handler.
        const nonDeviceHandler = options.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText(ast) === "nonDeviceHandler",
        )?.initializer;
        index.registrations.push({ name: name.text, handler, nonDeviceHandler });
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["defineDeviceTool", "definePlainTool"].includes(node.expression.text) &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      // defineDeviceTool({ name, handler, options: { outputSchema } }) (#11824)
      const definition = node.arguments[0];
      const property = (key: string) =>
        definition.properties.find(
          (candidate): candidate is ts.PropertyAssignment =>
            ts.isPropertyAssignment(candidate) && candidate.name.getText(ast) === key,
        );
      const name = property("name")?.initializer;
      const handler = property("handler")?.initializer;
      const options = property("options")?.initializer;
      const hasOutputSchema =
        options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (candidate) =>
            ts.isPropertyAssignment(candidate) && candidate.name.getText(ast) === "outputSchema",
        );
      if (name && ts.isStringLiteral(name) && hasOutputSchema) {
        if (handler) {
          index.registrations.push({ name: name.text, handler });
        } else if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          // Late-bound handler: paired below with `<variable>.register(registry, handler)`.
          lateBound.set(node.parent.name.text, name.text);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.name.text === "register" &&
      node.arguments[1]
    ) {
      lateRegistrations.push({
        variable: node.expression.expression.text,
        handler: node.arguments[1],
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const { variable, handler } of lateRegistrations) {
    const name = lateBound.get(variable);
    if (name) {
      index.registrations.push({ name, handler });
    }
  }
  return index;
}
function auditHandler(
  indexes: Map<string, SourceIndex>,
  file: string,
  handler: ts.Node,
  pathApi = path,
) {
  const visited = new Set<ts.Node>();
  const offenders: string[] = [];
  let structured = false;
  const visitedBindings = new Set<string>();
  function visitBinding(file: string, name: string): void {
    const key = `${sourceKey(file, pathApi)}#${name}`;
    const index = indexes.get(sourceKey(file, pathApi));
    if (!index || visitedBindings.has(key)) {
      return;
    }
    visitedBindings.add(key);
    const binding = index.bindings.get(name);
    if (binding) {
      visit(file, binding);
      return;
    }
    const imported = index.imports.get(name);
    if (imported) {
      visitBinding(imported.file, imported.name);
    }
    for (const target of index.reexports) {
      visitBinding(target, name);
    }
  }
  function visit(currentFile: string, node: ts.Node): void {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    const index = indexes.get(sourceKey(currentFile, pathApi))!;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name === "createStructuredToolResponse") {
        structured = true;
      }
      if (name === "createJSONToolResponse" || name === "createImageToolResponse") {
        offenders.push(
          `${currentFile}:${index.source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        );
      }
    }
    if (
      ts.isIdentifier(node) &&
      (node === handler ||
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        // `{ hook: handlers.prepareDevice }` passed into a factory: follow the object that built
        // the handler set, since a hook injected at construction (#11827) is no longer defined
        // inside the factory body the audit walks.
        (ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node &&
          ts.isPropertyAssignment(node.parent.parent) &&
          node.parent.parent.initializer === node.parent) ||
        (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) ||
        (ts.isShorthandPropertyAssignment(node.parent) &&
          ts.isObjectLiteralExpression(node.parent.parent) &&
          ts.isReturnStatement(node.parent.parent.parent)))
    ) {
      visitBinding(currentFile, node.text);
    }
    if (
      ts.isObjectLiteralExpression(node) &&
      ts.isReturnStatement(node.parent) &&
      !node.properties.some(ts.isSpreadAssignment)
    ) {
      const names = node.properties
        .filter(ts.isPropertyAssignment)
        .map((property) => property.name.getText(index.source));
      if (
        names.includes("content") &&
        !names.includes("structuredContent") &&
        !node.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(index.source) === "isError" &&
            property.initializer.kind === ts.SyntaxKind.TrueKeyword,
        )
      ) {
        offenders.push(
          `${currentFile}:${index.source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: text-only envelope`,
        );
      }
    }
    ts.forEachChild(node, (child) => visit(currentFile, child));
  }
  visit(file, handler);
  return { structured, offenders };
}

let sourceAudit: Array<{ name: string; structured: boolean; offenders: string[] }>;
beforeAll(() => {
  const indexes = new Map<string, SourceIndex>();
  for (const cwd of auditedDirectories) {
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd, absolute: true })) {
      indexes.set(sourceKey(file), indexSource(file, readFileSync(file, "utf8")));
    }
  }
  sourceAudit = [...indexes].flatMap(([file, index]) =>
    index.registrations.map(({ name, handler, nonDeviceHandler }) => {
      const audits = [handler, ...(nonDeviceHandler ? [nonDeviceHandler] : [])].map((target) =>
        auditHandler(indexes, file, target),
      );
      return {
        name,
        structured: audits.some((audit) => audit.structured),
        offenders: audits.flatMap((audit) => audit.offenders),
      };
    }),
  );
});
test("every schema registration reaches a structured builder and no text-only builder", () => {
  // 104 registrations today; a large drop means the indexer stopped recognising a registration form.
  expect(sourceAudit.length).toBeGreaterThanOrEqual(100);
  expect(
    sourceAudit.filter(({ structured, offenders }) => !structured || offenders.length > 0),
  ).toEqual([]);
});

test("source guard detects helper and raw text envelopes while exempting error envelopes", () => {
  const file = path.join(serverDirectory, "fixture.ts");
  const index = indexSource(
    file,
    `
    function helper() { return createJSONToolResponse({ success: true }); }
    function bad() { return helper(); }
    function raw() { return { content: [{ type: "text", text: "ok" }] }; }
    function good() { return createStructuredToolResponse({ success: true }); }
    function error() { return { content: [], isError: true }; }
  `,
  );
  const indexes = new Map([[sourceKey(file), index]]);
  expect(auditHandler(indexes, file, index.bindings.get("bad")!).offenders).toHaveLength(1);
  expect(auditHandler(indexes, file, index.bindings.get("raw")!).offenders).toHaveLength(1);
  expect(auditHandler(indexes, file, index.bindings.get("good")!)).toEqual({
    structured: true,
    offenders: [],
  });
  expect(auditHandler(indexes, file, index.bindings.get("error")!).offenders).toEqual([]);
});

test("source guard captures nonDeviceHandler so session-resolved tools are audited", () => {
  const file = path.join(serverDirectory, "nonDevice.ts");
  const index = indexSource(
    file,
    `ToolRegistry.registerDeviceAware("viaNonDevice", "", schema, {
  handler: async () => { throw new Error("x"); },
  outputSchema: schema,
  nonDeviceHandler: async () => createJSONToolResponse({ success: true }),
});`,
  );
  const indexes = new Map([[sourceKey(file), index]]);
  const [registration] = index.registrations;
  expect(registration?.nonDeviceHandler).toBeDefined();
  expect(auditHandler(indexes, file, registration!.nonDeviceHandler!).offenders).toHaveLength(1);
});

test("source guard follows factory helpers returned through object shorthand", () => {
  const registrationFile = path.join(serverDirectory, "registrations.ts");
  const handlerFile = path.join(serverDirectory, "handlers.ts");
  const registrationIndex = indexSource(
    registrationFile,
    `import { createGoodHandlers, createBadHandlers, createMixedHandlers } from "./handlers";
const { structured } = createGoodHandlers();
const { textOnly } = createBadHandlers();
const { mixed } = createMixedHandlers();
ToolRegistry.register("good", "", schema, { handler: structured, outputSchema: schema });
ToolRegistry.register("bad", "", schema, { handler: textOnly, outputSchema: schema });
ToolRegistry.register("mixed", "", schema, { handler: mixed, outputSchema: schema });`,
  );
  const handlerIndex = indexSource(
    handlerFile,
    `function structured() { return createStructuredToolResponse({ success: true }); }
function textOnly() { return createJSONToolResponse({ success: true }); }
function mixed() { textOnly(); return structured(); }
export function createGoodHandlers() { return { structured }; }
export function createBadHandlers() { return { textOnly }; }
export function createMixedHandlers() { return { mixed }; }`,
  );
  const indexes = new Map([
    [sourceKey(registrationFile), registrationIndex],
    [sourceKey(handlerFile), handlerIndex],
  ]);
  expect(registrationIndex.registrations).toHaveLength(3);
  expect(
    registrationIndex.registrations.map(({ name, handler }) => ({
      name,
      ...auditHandler(indexes, registrationFile, handler),
    })),
  ).toEqual([
    { name: "good", structured: true, offenders: [] },
    { name: "bad", structured: false, offenders: [`${handlerFile}:2`] },
    { name: "mixed", structured: true, offenders: [`${handlerFile}:2`] },
  ]);
});

test("follows a hook injected into a handler factory from a sibling handler set (#11827)", () => {
  const registrationFile = path.join(serverDirectory, "injectedRegistrations.ts");
  const handlerFile = path.join(serverDirectory, "injectedHandlers.ts");
  const registrationIndex = indexSource(
    registrationFile,
    `import { createBase, createStart } from "./injectedHandlers";
const base = createBase();
const { start } = createStart({ prepare: base.prepare });
ToolRegistry.register("start", "", schema, { handler: (args) => start(args), outputSchema: schema });`,
  );
  const handlerIndex = indexSource(
    handlerFile,
    `function ready() { return createStructuredToolResponse({ success: true }); }
export function createBase() { return { prepare: () => ready() }; }
export function createStart(hooks) { const start = (args) => hooks.prepare(args); return { start }; }`,
  );
  const indexes = new Map([
    [sourceKey(registrationFile), registrationIndex],
    [sourceKey(handlerFile), handlerIndex],
  ]);
  expect(
    registrationIndex.registrations.map(({ name, handler }) => ({
      name,
      ...auditHandler(indexes, registrationFile, handler),
    })),
  ).toEqual([{ name: "start", structured: true, offenders: [] }]);
});

test("source paths use Windows containment and canonical keys", () => {
  const directory = String.raw`C:\repo\src\server`;
  const file = String.raw`C:\repo\src\server\handlers\x.ts`;
  expect(isInside(directory, file, path.win32)).toBe(true);
  expect(isInside(directory, "c:/repo/src/server/handlers/x.ts", path.win32)).toBe(true);
  expect(isInside(directory, directory, path.win32)).toBe(false);
  expect(isInside(directory, String.raw`C:\repo\src`, path.win32)).toBe(false);
  expect(isInside(directory, String.raw`C:\repo\src\other\x.ts`, path.win32)).toBe(false);
  expect(isInside(directory, String.raw`C:\repo\src\server-extra\x.ts`, path.win32)).toBe(false);
  expect(isInside(directory, String.raw`D:\repo\src\server\x.ts`, path.win32)).toBe(false);
  expect(isInside(directory, String.raw`C:\repo\src\server\..helpers\x.ts`, path.win32)).toBe(true);
  expect(isInside(directory, String.raw`C:\repo\src\server\..\other\x.ts`, path.win32)).toBe(false);
  expect(sourceKey(file, path.win32)).toBe("c:/repo/src/server/handlers/x.ts");
  expect(sourceKey("c:/repo/src/server/handlers/../handlers/X.ts", path.win32)).toBe(
    sourceKey(file, path.win32),
  );
  // POSIX filenames remain case-sensitive and may contain literal backslashes.
  expect(sourceKey("/repo/server/../server/X.ts", path.posix)).toBe("/repo/server/X.ts");
  expect(sourceKey(String.raw`/repo/server/a\b.ts`, path.posix)).toBe(
    String.raw`/repo/server/a\b.ts`,
  );
});

test("source guard follows named and star re-exports, including cyclic barrels", () => {
  const files = new Map([
    [
      "registration.ts",
      `import { good, bad } from "./barrel";
ToolRegistry.register("good", "", schema, { handler: good, outputSchema: schema });
ToolRegistry.register("bad", "", schema, { handler: bad, outputSchema: schema });`,
    ],
    ["barrel.ts", `export * from "./responses"; export * from "./cycle";`],
    ["cycle.ts", `export * from "./barrel";`],
    ["responses.ts", `export { structured as good, text as bad } from "./builders";`],
    [
      "builders.ts",
      `export function structured() { return createStructuredToolResponse({}); }
export function text() { return createJSONToolResponse({}); }`,
    ],
  ]);
  const indexes = new Map(
    [...files].map(([name, source]) => {
      const file = path.join(serverDirectory, name);
      return [sourceKey(file), indexSource(file, source)];
    }),
  );
  const file = path.join(serverDirectory, "registration.ts");
  const results = indexes.get(sourceKey(file))!.registrations.map(({ name, handler }) => ({
    name,
    ...auditHandler(indexes, file, handler),
  }));
  expect(results).toEqual([
    { name: "good", structured: true, offenders: [] },
    {
      name: "bad",
      structured: false,
      offenders: [`${path.join(serverDirectory, "builders.ts")}:2`],
    },
  ]);
});

test("source guard follows Windows cross-file handlers and rejects text-only builders", () => {
  const directory = String.raw`C:\repo\src\server`;
  const registrationFile = String.raw`C:\repo\src\server\registrations.ts`;
  const handlerFile = "c:/repo/src/server/handlers/responses.ts";
  const registrationIndex = indexSource(
    registrationFile,
    `import { good as structuredHandler, bad as textHandler } from "./handlers/responses";
ToolRegistry.register("structured", "", schema, { handler: structuredHandler, outputSchema: schema });
ToolRegistry.registerDeviceAware("text", "", schema, { handler: textHandler, outputSchema: schema });`,
    directory,
    path.win32,
  );
  const handlerIndex = indexSource(
    handlerFile,
    `export function good() { return createStructuredToolResponse({ success: true }); }
export function bad() { return createJSONToolResponse({ success: true }); }`,
    directory,
    path.win32,
  );
  const indexes = new Map([
    [sourceKey(registrationFile, path.win32), registrationIndex],
    [sourceKey(handlerFile, path.win32), handlerIndex],
  ]);
  expect(registrationIndex.registrations).toHaveLength(2);
  expect(registrationIndex.imports.get("structuredHandler")).toEqual({
    file: String.raw`C:\repo\src\server\handlers\responses.ts`,
    name: "good",
  });
  const results = registrationIndex.registrations.map(({ name, handler }) => ({
    name,
    ...auditHandler(indexes, registrationFile, handler, path.win32),
  }));
  expect(results).toEqual([
    { name: "structured", structured: true, offenders: [] },
    {
      name: "text",
      structured: false,
      offenders: [String.raw`C:\repo\src\server\handlers\responses.ts:2`],
    },
  ]);
});

test("source guard preserves audit results and line numbers with CRLF input", () => {
  const directory = String.raw`C:\repo\src\server`;
  const file = String.raw`C:\repo\src\server\fixture.ts`;
  const source = `function helper() {
  return createJSONToolResponse({ success: true });
}
function mixed() {
  helper();
  return createStructuredToolResponse({ success: true });
}
function raw() {
  return { content: [{ type: "text", text: "ok" }] };
}
function error() {
  return { content: [], isError: true };
}
ToolRegistry.register("mixed", "", schema, { handler: mixed, outputSchema: schema });
ToolRegistry.register("raw", "", schema, { handler: raw, outputSchema: schema });
ToolRegistry.register("error", "", schema, { handler: error, outputSchema: schema });`;
  const audit = (input: string) => {
    const index = indexSource(file, input, directory, path.win32);
    const indexes = new Map([[sourceKey(file, path.win32), index]]);
    return index.registrations.map(({ name, handler }) => ({
      name,
      ...auditHandler(indexes, file, handler, path.win32),
    }));
  };
  const lf = audit(source);
  expect(lf).toEqual([
    { name: "mixed", structured: true, offenders: [`${file}:2`] },
    { name: "raw", structured: false, offenders: [`${file}:9: text-only envelope`] },
    { name: "error", structured: false, offenders: [] },
  ]);
  expect(audit(source.replace(/\n/g, "\r\n"))).toEqual(lf);
});
