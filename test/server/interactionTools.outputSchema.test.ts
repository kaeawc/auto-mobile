import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import type { BootedDevice, KeyboardResult } from "../../src/models";
import type { SendKeysResult } from "../../src/features/action/SendKeys";
import { AndroidImeCatalog } from "../../src/features/action/AndroidImeCatalog";
import { InstalledImeKeySession } from "../../src/features/action/InstalledImeKeySession";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import {
  registerInteractionTools,
  resetKeyboardFactory,
  resetOpenUrlFactory,
  resetSendKeysFactory,
  setKeyboardFactory,
  setOpenUrlFactory,
  setSendKeysFactory,
  setShakeFactory,
  resetShakeFactory,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createJSONToolResponse } from "../../src/utils/toolUtils";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();
const device: BootedDevice = { deviceId: "fake-output-schema", name: "Fake", platform: "android" };
const validators = new Map<string, JsonSchemaValidator<unknown>>();

// Compile the same validators the SDK caches on tools/list, outside test timing.
beforeAll(() => {
  registerInteractionTools();
  const provider = new AjvJsonSchemaValidator();
  for (const name of ["sendKeys", "keyboard", "openLink"]) {
    const definition = ToolRegistry.getToolDefinitions().find((tool) => tool.name === name)!;
    // Disabled tools are still registered; use their registered schema directly.
    const schema =
      definition?.outputSchema ?? ToolRegistry.getTool(name)!.outputSchema!.toJSONSchema();
    validators.set(name, provider.getValidator(schema));
  }
});
beforeEach(() => registerInteractionTools());
afterEach(() => {
  resetSendKeysFactory();
  resetKeyboardFactory();
  resetOpenUrlFactory();
  resetShakeFactory();
});

async function checkResponse(
  name: string,
  args: Record<string, unknown>,
  payload: object,
  isError?: boolean,
) {
  const tool = ToolRegistry.getTool(name)!;
  const response = await tool.deviceAwareHandler!(device, args);
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
    setSendKeysFactory(() => ({ execute: async () => result }));
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
      setKeyboardFactory(() => ({ execute: async () => result }));
      await checkResponse("keyboard", { action }, result);
    });
  }
}

test("keyboard exceptions still throw actionable errors", async () => {
  setKeyboardFactory(() => ({
    execute: async () => {
      throw new Error("failed");
    },
  }));
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
    setOpenUrlFactory(() => ({ execute: async () => result }));
    await checkResponse(
      "openLink",
      { url: result.url },
      {
        message: success ? `Opened link ${result.url}` : `Failed to open ${result.url}: failed`,
        ...result,
      },
    );
  });
}

test("neighbouring shake retains its text-only envelope", async () => {
  const result = { success: true, duration: 10, intensity: 20 };
  setShakeFactory(() => ({ execute: async () => result }));
  const tool = ToolRegistry.getTool("shake")!;
  expect(tool.outputSchema).toBeUndefined();
  expect(await tool.deviceAwareHandler!(device, { duration: 10, intensity: 20 })).toEqual(
    createJSONToolResponse({
      message: "Shook device for 10ms with intensity 20",
      observation: undefined,
      ...result,
    }),
  );
});

// Source contract: follow registered schema handlers, local helpers and server-module
// imports/factories. Device execution is deliberately outside this static guard.
interface SourceIndex {
  source: ts.SourceFile;
  bindings: Map<string, ts.Node>;
  imports: Map<string, { file: string; name: string }>;
  registrations: Array<{ name: string; handler: ts.Expression }>;
}
const serverDirectory = resolve(import.meta.dir, "../../src/server");
function indexSource(file: string, source: string): SourceIndex {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const index: SourceIndex = {
    source: ast,
    bindings: new Map(),
    imports: new Map(),
    registrations: [],
  };
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
          if (ts.isIdentifier(element.name)) {
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
      const target = resolve(dirname(file), `${node.moduleSpecifier.text}.ts`);
      const names = node.importClause?.namedBindings;
      if (target.startsWith(`${serverDirectory}/`) && names && ts.isNamedImports(names)) {
        for (const element of names.elements) {
          index.imports.set(element.name.text, {
            file: target,
            name: element.propertyName?.text ?? element.name.text,
          });
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
      const [name, , , handler, options] = node.arguments;
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
        index.registrations.push({ name: name.text, handler });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return index;
}
function auditHandler(indexes: Map<string, SourceIndex>, file: string, handler: ts.Node) {
  const visited = new Set<ts.Node>();
  const offenders: string[] = [];
  let structured = false;
  function visit(currentFile: string, node: ts.Node): void {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    const index = indexes.get(currentFile)!;
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
        (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node))
    ) {
      const binding = index.bindings.get(node.text);
      if (binding) {
        visit(currentFile, binding);
      }
      const imported = index.imports.get(node.text);
      const importedBinding = imported && indexes.get(imported.file)?.bindings.get(imported.name);
      if (imported && importedBinding) {
        visit(imported.file, importedBinding);
      }
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
  for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: serverDirectory, absolute: true })) {
    indexes.set(file, indexSource(file, readFileSync(file, "utf8")));
  }
  sourceAudit = [...indexes].flatMap(([file, index]) =>
    index.registrations.map(({ name, handler }) => ({
      name,
      ...auditHandler(indexes, file, handler),
    })),
  );
});
test("every schema registration reaches a structured builder and no text-only builder", () => {
  expect(sourceAudit.length).toBeGreaterThanOrEqual(25);
  expect(
    sourceAudit.filter(({ structured, offenders }) => !structured || offenders.length > 0),
  ).toEqual([]);
});

test("source guard detects helper and raw text envelopes while exempting error envelopes", () => {
  const file = join(serverDirectory, "fixture.ts");
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
  const indexes = new Map([[file, index]]);
  expect(auditHandler(indexes, file, index.bindings.get("bad")!).offenders).toHaveLength(1);
  expect(auditHandler(indexes, file, index.bindings.get("raw")!).offenders).toHaveLength(1);
  expect(auditHandler(indexes, file, index.bindings.get("good")!)).toEqual({
    structured: true,
    offenders: [],
  });
  expect(auditHandler(indexes, file, index.bindings.get("error")!).offenders).toEqual([]);
});
