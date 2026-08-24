import { errorMessage } from "../utils/describeUnknownError";
import { ToolRegistry } from "../server/toolRegistry";
import { logger } from "../utils/logger";
import { ActionableError } from "../models";
import { DaemonClient, DaemonUnavailableError } from "../daemon/client";
import { DaemonMcpProxy } from "../daemon/daemonMcpProxy";
import type { DaemonMcpProxyConfig } from "../daemon/daemonMcpProxy";
import type { DaemonOptions } from "../daemon/types";
import { resolveDaemonInstallSpecifier } from "../constants/release";

// Import all tool registration functions
import { registerObserveTools } from "../server/observeTools";
import { registerInteractionTools } from "../server/interactionTools";
import { registerAppTools } from "../server/appTools";
import { registerUtilityTools } from "../server/utilityTools";
import { registerDeviceTools } from "../server/deviceTools";
import { registerPlanTools } from "../server/planTools";
import { registerDoctorTools } from "../server/doctorTools";
import { registerVideoRecordingTools } from "../server/videoRecordingTools";
import { registerNotificationTools } from "../server/notificationTools";
import { registerAccessibilityFocusTools } from "../server/accessibilityFocusTools";
import { registerAccessibilityTools } from "../server/accessibilityTools";
import { registerAppFileTools } from "../server/appFileTools";
import { registerSharedStorageTools } from "../server/sharedStorageTools";
import { registerBarrierTools } from "../server/barrierTools";
import { registerBiometricTools } from "../server/biometricTools";
import { registerCriticalSectionTools } from "../server/criticalSectionTools";
import { registerDatabaseTools } from "../server/databaseTools";
import { registerDebugTools } from "../server/debugTools";
import { registerDeepLinkTools } from "../server/deepLinkTools";
import { registerFormTools } from "../server/formTools";
import { registerHighlightTools } from "../server/highlightTools";
import { registerNavigationTools } from "../server/navigationTools";
import { registerNetworkTools } from "../server/networkTools";
import { registerPreferenceTools } from "../server/preferenceTools";
import { registerSnapshotTools } from "../server/snapshotTools";
import { registerStorageTools } from "../server/storageTools";
import { registerTelephonyTools } from "../server/telephonyTools";

type CliHelpSchemaShape = Record<string, any> | undefined;
interface CliHelpParameterInfo {
  isOptional: boolean;
  typeName: string;
  description?: string;
}

// Initialize tool registry for CLI mode
function initializeCliTools(): void {
  // Register all tool categories
  registerObserveTools();
  registerInteractionTools();
  registerAppTools();
  registerUtilityTools();
  registerDeviceTools();
  registerPlanTools();
  registerDoctorTools();
  registerVideoRecordingTools();
  registerNotificationTools();
  registerAccessibilityFocusTools();
  registerAccessibilityTools();
  registerAppFileTools();
  registerSharedStorageTools();
  registerBarrierTools();
  registerBiometricTools();
  registerCriticalSectionTools();
  registerDatabaseTools();
  registerDebugTools();
  registerDeepLinkTools();
  registerFormTools();
  registerHighlightTools();
  registerNavigationTools();
  registerNetworkTools();
  registerPreferenceTools();
  registerSnapshotTools();
  registerStorageTools();
  registerTelephonyTools();
}

// Parse CLI arguments into tool name, session UUID, and parameters
/**
 * Coerce a raw CLI token using the tool's declared zod type.
 *
 * Running every value through `JSON.parse` made numeric-looking strings
 * unpassable: `JSON.parse("12345")` yields a number, so `inputText --text 12345`
 * and `sendSms --phoneNumber 5551234567` were rejected as
 * "expected string, received number" (#4241). A phone number, PIN, OTP or zip
 * code is a string whose natural value is digits, and the token alone cannot say
 * which the caller meant — only the schema can.
 *
 * The declared type wins where we know it; otherwise we keep the previous
 * best-effort JSON behaviour so unknown tools and undeclared params are
 * unaffected.
 */
/**
 * Parse a CLI token as JSON, reporting whether it was JSON at all.
 *
 * A token that is not JSON is the common case, not an error — `--text plain` and
 * `--action tap` are ordinary input — so the failure is logged at debug and the
 * caller decides what the raw token means.
 */
function tryParseJsonToken(raw: string): { parsed: boolean; value: unknown } {
  try {
    return { parsed: true, value: JSON.parse(raw) };
  } catch (error) {
    logger.debug(`[cli] value is not JSON, treating as a raw token: ${raw} (${error})`);
    return { parsed: false, value: raw };
  }
}

function coerceCliValue(raw: string, declared: DeclaredType | undefined): unknown {
  const bestEffort = (): unknown => tryParseJsonToken(raw).value;

  // A nullable param must still be able to receive an explicit JSON null --
  // storageTools removes a key only when `value === null`, so turning the token
  // into the string "null" would overwrite it instead of clearing it.
  if (declared?.nullable && raw === "null") {
    return null;
  }

  const typeName = declared?.type;

  switch (typeName) {
    // Enums are string-valued here (e.g. --action start); treating them as
    // strings avoids a member that happens to look numeric being coerced.
    case "string":
    case "enum":
      return asDeclaredString(raw);
    case "number":
    case "bigint":
      return asDeclaredNumber(raw);
    case "boolean":
      if (raw === "true") {
        return true;
      }
      if (raw === "false") {
        return false;
      }
      return bestEffort();
    default:
      return bestEffort();
  }
}

/**
 * A string param's value.
 *
 * The bare token is the answer, except when the caller JSON-encoded it —
 * `--text '"12345"'` must still yield `12345`, not a token with literal quote
 * characters, since generated wrappers legitimately encode scalars that way.
 */
function asDeclaredString(raw: string): string {
  const { parsed, value } = tryParseJsonToken(raw);
  return parsed && typeof value === "string" ? value : raw;
}

/**
 * A number param's value, or the raw token when it is not a JSON number.
 *
 * `Number()` accepts things JSON does not — `""` and `" "` become `0`, `"0x10"`
 * becomes `16` — which would silently pass a wrong value to the daemon instead of
 * letting schema validation reject a bad argument. Returning the raw token keeps
 * the rejection.
 */
function asDeclaredNumber(raw: string): unknown {
  const { parsed, value } = tryParseJsonToken(raw);
  return parsed && typeof value === "number" && Number.isFinite(value) ? value : raw;
}

/**
 * Declared parameter types for a tool, or null when the tool is unknown.
 *
 * Registers the tool categories first: `runCliCommand` only calls
 * `initializeCliTools()` on the no-args and `help` branches, not on the
 * tool-execution path, so without this the registry is empty exactly when a real
 * `--cli <tool>` invocation needs it and every value would silently fall back to
 * the old JSON coercion. Registration is idempotent (the registry is a Map keyed
 * by tool name), so calling it per invocation is safe.
 */
function getDeclaredParamTypes(toolName: string): Record<string, DeclaredType> | null {
  initializeCliTools();
  const tool = ToolRegistry.getTool(toolName);
  if (!tool) {
    return null;
  }

  const shapes = collectSchemaShapes(tool.schema);
  if (shapes.length === 0) {
    return null;
  }

  // A param declared with different types across union branches cannot be
  // coerced unambiguously from the token alone, so it is omitted and falls back
  // to best-effort parsing rather than being coerced to the wrong branch's type.
  // Nullability is unioned: if any branch accepts null, a JSON null must survive.
  const byParam = new Map<string, { types: Set<string>; nullable: boolean }>();
  for (const shape of shapes) {
    for (const [key, value] of Object.entries(shape)) {
      const declared = resolveDeclaredType(value);
      const entry = byParam.get(key) ?? { types: new Set<string>(), nullable: false };
      entry.types.add(declared.type);
      entry.nullable = entry.nullable || declared.nullable;
      byParam.set(key, entry);
    }
  }

  return Object.fromEntries(
    [...byParam.entries()]
      .filter(([, entry]) => entry.types.size === 1)
      .map(([key, entry]) => [key, { type: [...entry.types][0], nullable: entry.nullable }]),
  );
}

/**
 * The effective declared type of a parameter, seeing through wrappers.
 *
 * `getCliHelpParameterInfo` unwraps `optional` only, so a wrapped param reports
 * the wrapper (`nullable`, `default`) instead of the type underneath and falls
 * back to JSON coercion — `setKeyValue --value 12345` sends the number `12345`
 * even though `storageTools.ts` declares `z.string().nullable()`. Wrappers are
 * peeled here so the inner type decides the coercion.
 *
 * A `literal` resolves to the runtime type of its value, so `z.literal("copy")`
 * coerces as a string rather than falling through.
 */
const SCHEMA_WRAPPER_TYPES = new Set([
  "optional",
  "nullable",
  "default",
  "readonly",
  "catch",
  "branded",
  "lazy",
]);

/** The zod type name of a schema, normalized ("ZodString" -> "string"). */
function schemaTypeName(schema: any): string {
  const raw = schema?._def?.typeName ?? schema?._def?.type ?? "unknown";
  return String(raw).replace(/^Zod/, "").toLowerCase();
}

/** The schema a wrapper wraps; the key varies across zod versions. */
function unwrapSchema(schema: any): any {
  const definition = schema?._def;
  return definition?.innerType ?? definition?.type ?? definition?.schema ?? null;
}

interface DeclaredType {
  type: string;
  /** True when a JSON `null` is a legal value and must survive coercion. */
  nullable: boolean;
}

function resolveDeclaredType(schema: any): DeclaredType {
  let current = schema;
  let nullable = false;

  for (let depth = 0; depth < 10 && current; depth++) {
    const name = schemaTypeName(current);

    if (name === "nullable") {
      nullable = true;
    }
    if (name === "literal") {
      return { type: typeof (current._def?.value ?? current._def?.values?.[0]), nullable };
    }
    if (!SCHEMA_WRAPPER_TYPES.has(name)) {
      return { type: name, nullable };
    }
    current = unwrapSchema(current);
  }

  return { type: "unknown", nullable };
}

/**
 * Every object shape a tool's schema can present.
 *
 * Union-rooted tools (`clipboard`, `deviceSnapshot`, and `postNotification` via a
 * pipe into a union) have no single shape, so a lookup that only understands a
 * flat object returns nothing and their params silently keep the old JSON
 * coercion — `clipboard --action copy --text 12345` would still send a number.
 * Branches are collected so those tools are typed too.
 */
function collectSchemaShapes(schema: any): Record<string, any>[] {
  const definition = schema?._def;
  if (!definition) {
    return [];
  }

  if (definition.shape) {
    return [definition.shape];
  }

  const options = definition.options ?? definition.out?._def?.options;
  if (Array.isArray(options)) {
    return options.flatMap((option: any) => collectSchemaShapes(option));
  }

  if (definition.out) {
    return collectSchemaShapes(definition.out);
  }

  return [];
}

export function parseCliArgs(args: string[]): {
  toolName: string;
  sessionUuid?: string;
  params: Record<string, any>;
} {
  if (args.length === 0) {
    throw new ActionableError(
      "No tool name provided. Usage: --cli [--session-uuid <uuid>] <tool-name> [--param value ...]",
    );
  }

  let toolNameIndex = 0;
  let sessionUuid: string | undefined;

  // Check for --session-uuid parameter before tool name
  if (args[0] === "--session-uuid") {
    if (args.length < 3) {
      throw new ActionableError("--session-uuid requires a value and a tool name");
    }
    sessionUuid = args[1];
    toolNameIndex = 2;
  }

  const toolName = args[toolNameIndex];
  const params: Record<string, any> = {};
  const declaredTypes = getDeclaredParamTypes(toolName);

  // Parse remaining arguments as key-value pairs or boolean flags
  for (let i = toolNameIndex + 1; i < args.length; i++) {
    const key = args[i];

    if (!key.startsWith("--")) {
      throw new ActionableError(`Invalid parameter format: ${key}. Parameters must start with --`);
    }

    // Remove '--' prefix and convert kebab-case to camelCase
    // e.g., --session-uuid -> sessionUuid
    const paramName = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

    const nextArg = args[i + 1];

    // Check if this is a boolean flag (no value or next arg is also a flag)
    if (nextArg === undefined || nextArg.startsWith("--")) {
      // Boolean flag without value - treat as true
      params[paramName] = true;
    } else {
      // Key-value pair
      i++; // Skip the value in the next iteration

      params[paramName] = coerceCliValue(nextArg, declaredTypes?.[paramName]);
    }
  }

  return { toolName, sessionUuid, params };
}

/**
 * Execute tool via daemon (mandatory - no fallback).
 *
 * Routes through {@link DaemonMcpProxy} rather than a raw `DaemonClient` so the
 * daemon is auto-started AND its version/build identity is reconciled before the
 * call (#2744): a stale different-version/build daemon on the shared socket is
 * restarted to this CLI's build instead of rejecting the request with no self-heal.
 */
/**
 * Factory for the daemon proxy, overridable in tests so the CLI's option
 * threading can be observed without globally mocking the daemonMcpProxy module
 * (which would replace the real DaemonMcpProxy that daemonMcpProxy.test.ts needs).
 */
let daemonProxyFactory: (config: DaemonMcpProxyConfig) => DaemonMcpProxy = (config) =>
  new DaemonMcpProxy(config);

export function setDaemonProxyFactoryForTesting(
  factory: (config: DaemonMcpProxyConfig) => DaemonMcpProxy,
): void {
  daemonProxyFactory = factory;
}

export function resetDaemonProxyFactoryForTesting(): void {
  daemonProxyFactory = (config) => new DaemonMcpProxy(config);
}

async function runToolViaDaemon(
  toolName: string,
  params: Record<string, any>,
  daemonOptions?: DaemonOptions,
): Promise<any> {
  const proxy = daemonProxyFactory({ daemonOptions });

  try {
    const result = await proxy.callTool(toolName, params);
    if (result === null) {
      throw new ActionableError(
        "Daemon returned null result. This may indicate a daemon connectivity issue. " +
          `Try: bunx ${resolveDaemonInstallSpecifier()} --daemon restart`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      throw new ActionableError(
        `Daemon became unavailable during tool execution: ${error.message}. ` +
          `Try: auto-mobile --daemon restart`,
      );
    }
    if (error instanceof ActionableError) {
      throw error;
    }
    const message = errorMessage(error);
    throw new ActionableError(
      `Error calling daemon: ${message}. ` + `Try: auto-mobile --daemon restart`,
    );
  } finally {
    // Always close the proxy connection to prevent connection leaks
    await proxy.close();
  }
}

/**
 * Run `doctor` against the daemon as a diagnostic — deliberately NOT via {@link DaemonMcpProxy}.
 *
 * Doctor must *report* a wrong-version/build daemon, not silently restart it (which would defeat
 * the diagnosis and wedge active sessions just because a user ran `--cli doctor`). It therefore
 * uses a raw, non-reconciling `DaemonClient` with a null identity so the request bypasses the
 * server handshake gate (#2744): even a skewed daemon answers, and the client-side
 * {@link handleDoctorResult}/`applyClientBuildIdentity` step reports the mismatch. Throws (→ direct
 * fallback) only when the daemon is unreachable.
 */
/** Remove CLI-only presentation options before calling the daemon's doctor tool. */
export function doctorToolParams(params: Record<string, any>): Record<string, any> {
  const doctorParams = { ...params };
  delete doctorParams.json;
  return doctorParams;
}

async function runDoctorViaDaemon(params: Record<string, any>): Promise<any> {
  const client = new DaemonClient(undefined, undefined, undefined, {}, null);
  try {
    // `json` controls CLI presentation only. The daemon's doctor tool accepts
    // diagnostic options, so do not forward the local formatting flag through
    // its strict schema.
    const result = await client.callTool("doctor", doctorToolParams(params));
    if (result === null) {
      throw new ActionableError(
        "Daemon returned null result for doctor. " +
          `Try: bunx ${resolveDaemonInstallSpecifier()} --daemon restart`,
      );
    }
    return result;
  } finally {
    await client.close();
  }
}

/**
 * Run the doctor command with daemon fallback to direct execution
 */
async function runDoctorCommand(params: Record<string, any>): Promise<void> {
  const jsonOutput = params.json === true;

  // Try daemon first
  try {
    logger.debug("Attempting to run doctor via daemon");
    const daemonResult = await runDoctorViaDaemon(params);
    await handleDoctorResult(daemonResult, jsonOutput);
    return;
  } catch (error) {
    logger.debug(`Daemon not available for doctor, falling back to direct execution: ${error}`);
  }

  // Fallback to direct execution
  const { runDoctor, formatConsoleOutput, formatJsonOutput } = await import("../doctor");
  const report = await runDoctor({
    android: params.android,
    ios: params.ios,
  });

  if (jsonOutput) {
    console.log(formatJsonOutput(report));
  } else {
    console.log(formatConsoleOutput(report, process.stdout.isTTY ?? true));
  }

  // Exit with error code if any failures
  if (report.summary.failed > 0) {
    process.exit(1);
  }
}

/**
 * Handle doctor command result from daemon
 */
async function handleDoctorResult(result: any, jsonOutput: boolean): Promise<void> {
  // Extract the report from MCP response format
  let report = result;
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray(result.content)
  ) {
    if (result.content.length > 0 && result.content[0].type === "text") {
      try {
        report = JSON.parse(result.content[0].text);
      } catch {
        // Keep original result
      }
    }
  }

  // The daemon runs doctor in its own process, so its build-identity check
  // compared the daemon to itself. Recompute it here, client-side, so the
  // comparison uses THIS checkout's identity vs the daemon's PID-file identity
  // and a wrong-build skew is actually surfaced (issue #2736).
  try {
    const { applyClientBuildIdentity } = await import("../doctor");
    report = await applyClientBuildIdentity(report);
  } catch (error) {
    logger.debug(`Could not reconcile daemon build identity client-side: ${error}`);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // Use the formatter for console output
    const { formatConsoleOutput } = await import("../doctor");
    console.log(formatConsoleOutput(report, process.stdout.isTTY ?? true));
  }

  // Exit with error code if any failures
  if (report && report.summary && report.summary.failed > 0) {
    process.exit(1);
  }
}

function handleToolResult(result: any, toolName: string): void {
  console.log(JSON.stringify(result, null, 2));

  // Check if the result indicates failure and exit with code 1
  // Handle both direct result format and MCP content format
  let actualResult = result;
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray(result.content)
  ) {
    // MCP format - extract from content array
    if (result.content.length > 0 && result.content[0].type === "text") {
      try {
        actualResult = JSON.parse(result.content[0].text);
      } catch {
        // If parsing fails, keep the original result
        actualResult = result;
      }
    }
  }

  if (actualResult && typeof actualResult === "object" && actualResult.success === false) {
    // Write error message to STDERR
    if (actualResult.error) {
      console.error(actualResult.error);
    }

    // Special handling for executePlan tool
    if (toolName === "executePlan") {
      console.error(`Executed ${actualResult.executedSteps} of ${actualResult.totalSteps} steps`);
      if (actualResult.failedStep) {
        console.error(
          `Failed at step ${actualResult.failedStep.stepIndex + 1}: ${actualResult.failedStep.tool}`,
        );
        console.error(`Step error: ${actualResult.failedStep.error}`);
      }
    }

    process.exit(1);
  }
}

// Main CLI command runner
export async function runCliCommand(args: string[], daemonOptions?: DaemonOptions): Promise<void> {
  try {
    if (args.length === 0) {
      // Show help with available tools
      initializeCliTools();
      showHelp();
      return;
    }

    // Handle special commands
    if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
      initializeCliTools();
      if (args.length > 1) {
        showToolHelp(args[1]);
      } else {
        showHelp();
      }
      return;
    }

    // Parse tool name, session UUID, and parameters
    const { toolName, sessionUuid, params } = parseCliArgs(args);

    // Add session UUID to params if provided
    if (sessionUuid) {
      params.sessionUuid = sessionUuid;
      logger.debug(`Using session UUID: ${sessionUuid}`);
    }

    // Special handling for doctor command - try daemon first, fallback to direct
    if (toolName === "doctor") {
      await runDoctorCommand(params);
      return;
    }

    // All tool execution goes through daemon (mandatory)
    logger.debug(`Executing tool via daemon: ${toolName}`);
    const daemonResult = await runToolViaDaemon(toolName, params, daemonOptions);
    handleToolResult(daemonResult, toolName);

    // Note: Session cleanup for executePlan now happens automatically on the daemon side
    // See toolRegistry.ts registerDeviceAware() finally block
  } catch (error) {
    if (error instanceof ActionableError) {
      logger.error(`CLI Error: ${error.message}`);
      console.error(`Error: ${error.message}`);
    } else {
      logger.error(`Unexpected CLI Error: ${error}`);
      console.error(`Unexpected error: ${error}`);
    }
    process.exit(1);
  }
}

// Show general help
function showHelp(): void {
  const tools = ToolRegistry.getAllTools();
  // Concrete pinned specifier (honors AUTOMOBILE_VERSION), never the floating
  // @latest tag — help output should be reproducible (#2746).
  const installSpecifier = resolveDaemonInstallSpecifier();

  console.log(`
AutoMobile CLI - Android Device Automation

Usage:
  bunx ${installSpecifier} --cli [--session-uuid <uuid>] <tool-name> [--param value ...]
  bunx ${installSpecifier} --cli help [tool-name]

Examples:
  bunx ${installSpecifier} --cli listDeviceImages
  bunx ${installSpecifier} --cli observe
  bunx ${installSpecifier} --cli tapOn --text "Submit"
  bunx ${installSpecifier} --cli getAndroid --avd-name "pixel_7_api_34"
  bunx ${installSpecifier} --cli getApple --udid "SIMULATOR-UDID"
  bunx ${installSpecifier} --cli --session-uuid abc-123-uuid observe
  bunx ${installSpecifier} --cli --session-uuid $SESSION_UUID tapOn --text "Submit"

Options:
  help [tool-name]              Show help for a specific tool
  --session-uuid <uuid>         Associate tool execution with a session (optional)

Parameters:
  Parameters are passed as --key value pairs
  Values are converted using the tool's declared parameter type
  Strings: --text 12345 stays the string "12345"
  Boolean values: --flag true or --flag false
  Numbers: --count 5
  Objects: --options '{"key": "value"}'
  Unknown tools or parameters fall back to JSON-if-possible, otherwise string

Session-based Execution:
  When using --session-uuid, the tool will be executed on the device assigned to that session.
  This allows multiple tool calls to target the same device in parallel.
`);

  // Show categorized tools
  const categories = new Map<string, typeof tools>();

  const deviceTools = [
    "setActiveDevice",
    "listDevices",
    "listDeviceImages",
    "getAndroid",
    "getApple",
    "killDevice",
    "checkRunningDevices",
  ];
  const systemConfigTools = ["changeLocalization"];

  // Group tools by category (based on their prefixes or common patterns)
  tools.forEach((tool) => {
    let category = "General";

    if (systemConfigTools.includes(tool.name)) {
      category = "System Configuration";
    } else if (deviceTools.includes(tool.name)) {
      category = "Device Management";
    } else if (tool.name.includes("App") || tool.name.includes("app")) {
      category = "App Management";
    } else if (tool.name.startsWith("assert")) {
      category = "Assertions";
    } else if (tool.name.includes("observe")) {
      category = "Observation";
    } else if (tool.name.includes("Plan") || tool.name.includes("plan")) {
      category = "Plan Management";
    } else {
      category = "Interactions";
    }

    if (!categories.has(category)) {
      categories.set(category, []);
    }
    categories.get(category)!.push(tool);
  });

  console.log("\nAvailable Tools:");
  console.log("================");

  // Display tools by category
  categories.forEach((toolList, category) => {
    console.log(`\n${category}:`);
    toolList.forEach((tool) => {
      console.log(`  ${tool.name.padEnd(25)} - ${tool.description}`);
    });
  });

  console.log(`\nTotal: ${tools.length} tools available`);
  console.log(
    `\nUse 'bunx ${installSpecifier} --cli help <tool-name>' for detailed information about a specific tool.`,
  );
}

// Show help for a specific tool
function showToolHelp(toolName: string): void {
  const installSpecifier = resolveDaemonInstallSpecifier();
  const tool = ToolRegistry.getTool(toolName);
  if (!tool) {
    console.error(`Unknown tool: ${toolName}`);
    console.log(`\nUse 'bunx ${installSpecifier} --cli help' to see available tools.`);
    return;
  }

  console.log(`\nTool: ${tool.name}`);
  console.log("=".repeat(tool.name.length + 6));
  console.log(`Description: ${tool.description}`);

  if (tool.supportsProgress) {
    console.log("Supports: Progress notifications");
  }

  // Show schema information
  console.log("\nParameters:");
  try {
    const shape = getCliHelpSchemaShape(tool.schema);
    if (shape) {
      Object.entries(shape).forEach(([key, value]: [string, any]) => {
        const parameter = getCliHelpParameterInfo(value);

        console.log(`  --${key} ${parameter.isOptional ? "(optional)" : "(required)"}`);
        console.log(`    Type: ${parameter.typeName}`);

        if (parameter.description) {
          console.log(`    Description: ${parameter.description}`);
        }
      });
    } else {
      console.log("  No parameters required");
    }
  } catch (error) {
    console.log("  Could not parse parameter schema");
  }

  console.log(`\nExample usage:`);
  console.log(`  bunx ${installSpecifier} --cli ${toolName} [parameters...]`);
}

export function getCliHelpSchemaShape(schema: any): CliHelpSchemaShape {
  const definition = schema?._def;
  if (!definition) {
    return undefined;
  }

  if (definition.shape) {
    return definition.shape;
  }

  if (definition.type === "pipe" && definition.out?._def?.shape) {
    return definition.out._def.shape;
  }

  return undefined;
}

export function getCliHelpParameterInfo(schema: any): CliHelpParameterInfo {
  const isOptional =
    typeof schema?.isOptional === "function"
      ? schema.isOptional()
      : schema?._def?.typeName === "ZodOptional";
  const actualType = isOptional ? (schema?._def?.innerType ?? schema) : schema;
  const rawTypeName = actualType?._def?.typeName ?? actualType?._def?.type ?? "unknown";
  const typeName = String(rawTypeName).replace(/^Zod/, "").toLowerCase();

  return {
    isOptional,
    typeName,
    description: schema?.description ?? actualType?.description ?? actualType?._def?.description,
  };
}
