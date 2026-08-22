/** Persistent per-session overrides keyed by exact MCP tool name. */
export interface SessionToolSelectionRepository {
  list(sessionUuid: string): Promise<Map<string, boolean>>;
  set(sessionUuid: string, toolName: string, enabled: boolean): Promise<void>;
  deleteSession(sessionUuid: string): Promise<void>;
}

export type ToolDefaultOverrides = ReadonlyMap<string, boolean>;

/**
 * Resolves exact-tool availability. Tool registration owns the built-in
 * default; startup and session overrides only replace that declared value.
 */
export class SessionToolSelectionService {
  constructor(
    private readonly repository: SessionToolSelectionRepository,
    private readonly startupDefaults: ToolDefaultOverrides = new Map(),
  ) {}

  async isEnabled(
    sessionUuid: string | undefined,
    toolName: string,
    declaredDefault: boolean,
  ): Promise<boolean> {
    const startupDefault = this.startupDefaults.get(toolName) ?? declaredDefault;
    if (!sessionUuid) {
      return startupDefault;
    }
    const overrides = await this.repository.list(sessionUuid);
    return overrides.get(toolName) ?? startupDefault;
  }

  async getOverride(sessionUuid: string, toolName: string): Promise<boolean | undefined> {
    return (await this.repository.list(sessionUuid)).get(toolName);
  }

  async setEnabled(sessionUuid: string, toolName: string, enabled: boolean): Promise<void> {
    await this.repository.set(sessionUuid, toolName, enabled);
  }

  async deleteSession(sessionUuid: string): Promise<void> {
    await this.repository.deleteSession(sessionUuid);
  }
}

function parseToolNames(raw: string | undefined): string[] {
  return (
    raw
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}

export function getEnvironmentToolDefaults(
  environment: Readonly<Record<string, string | undefined>>,
  knownToolNames: ReadonlySet<string>,
): ToolDefaultOverrides {
  const retiredVariable = Object.keys(environment).find((name) =>
    name.startsWith("AUTOMOBILE_TOOLSET_"),
  );
  if (retiredVariable) {
    throw new Error(
      `${retiredVariable} is retired; use AUTOMOBILE_ENABLED_TOOLS or AUTOMOBILE_DISABLED_TOOLS with exact tool names.`,
    );
  }

  const enabled = parseToolNames(environment.AUTOMOBILE_ENABLED_TOOLS);
  const disabled = parseToolNames(environment.AUTOMOBILE_DISABLED_TOOLS);
  const unknown = [...enabled, ...disabled].find((toolName) => !knownToolNames.has(toolName));
  if (unknown) {
    throw new Error(`Unknown tool name '${unknown}' in AutoMobile tool defaults.`);
  }
  const disabledSet = new Set(disabled);
  const conflict = enabled.find((toolName) => disabledSet.has(toolName));
  if (conflict) {
    throw new Error(
      `Tool '${conflict}' cannot be both enabled and disabled in environment defaults.`,
    );
  }
  return new Map([
    ...enabled.map((toolName) => [toolName, true] as const),
    ...disabled.map((toolName) => [toolName, false] as const),
  ]);
}

function assertKnownToolNames(
  toolNames: readonly string[],
  knownToolNames: ReadonlySet<string>,
): void {
  const unknown = toolNames.find((toolName) => !knownToolNames.has(toolName));
  if (unknown) {
    throw new Error(`Unknown tool name '${unknown}' in AutoMobile tool defaults.`);
  }
}

export function getStartupToolDefaults(
  environment: Readonly<Record<string, string | undefined>>,
  knownToolNames: ReadonlySet<string>,
  enabledTools: readonly string[] = [],
  disabledTools: readonly string[] = [],
): ToolDefaultOverrides {
  assertKnownToolNames(enabledTools, knownToolNames);
  assertKnownToolNames(disabledTools, knownToolNames);
  const disabledSet = new Set(disabledTools);
  const conflict = enabledTools.find((toolName) => disabledSet.has(toolName));
  if (conflict) {
    throw new Error(`Tool '${conflict}' cannot be both enabled and disabled in CLI defaults.`);
  }
  return new Map([
    ...getEnvironmentToolDefaults(environment, knownToolNames),
    ...enabledTools.map((toolName) => [toolName, true] as const),
    ...disabledTools.map((toolName) => [toolName, false] as const),
  ]);
}

let defaultService: SessionToolSelectionService | undefined;
let configuredEnabledTools: readonly string[] = [];
let configuredDisabledTools: readonly string[] = [];

export function configureToolSelectionCliDefaults(
  enabledTools: readonly string[],
  disabledTools: readonly string[],
): void {
  configuredEnabledTools = [...enabledTools];
  configuredDisabledTools = [...disabledTools];
  defaultService = undefined;
}

export function validateConfiguredToolSelectionDefaults(
  knownToolNames: ReadonlySet<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  getStartupToolDefaults(
    environment,
    knownToolNames,
    configuredEnabledTools,
    configuredDisabledTools,
  );
}

export function getSessionToolSelectionService(): SessionToolSelectionService {
  if (!defaultService) {
    // Lazy imports avoid opening the production database during module loading
    // and resolve the registry only after all production tools are registered.
    const {
      SqliteSessionToolSelectionRepository,
    } = require("./SqliteSessionToolSelectionRepository");
    const { ToolRegistry } = require("../../server/toolRegistry");
    const knownToolNames = new Set<string>(ToolRegistry.getConfigurableToolNames());
    defaultService = new SessionToolSelectionService(
      new SqliteSessionToolSelectionRepository(),
      getStartupToolDefaults(
        process.env,
        knownToolNames,
        configuredEnabledTools,
        configuredDisabledTools,
      ),
    );
  }
  return defaultService;
}
