/** One tool's enable/disable decision inside a batch write. */
export interface SessionToolSelectionEntry {
  toolName: string;
  enabled: boolean;
}

/** Persistent per-session overrides keyed by exact MCP tool name. */
export interface SessionToolSelectionRepository {
  list(sessionUuid: string): Promise<Map<string, boolean>>;
  set(sessionUuid: string, toolName: string, enabled: boolean): Promise<void>;
  /**
   * Persist a whole batch atomically — either every entry lands or none does
   * (#6886 review). Optional: a repository that cannot offer that (an in-memory
   * test double) is written one entry at a time by the service instead. The
   * production SQLite repository implements it with a transaction, which is what
   * makes `setToolEnabled { toolNames: [...] }`'s advertised all-or-nothing
   * contract hold against a mid-batch write failure and against a concurrent
   * enable/disable batch for the same session.
   */
  setMany?(sessionUuid: string, entries: readonly SessionToolSelectionEntry[]): Promise<void>;
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

  /**
   * Apply one enable/disable decision to every name as a single write, so a
   * rejection can never leave a prefix of the batch applied (#6886 review).
   */
  async setEnabledMany(
    sessionUuid: string,
    toolNames: readonly string[],
    enabled: boolean,
  ): Promise<void> {
    const entries = toolNames.map((toolName) => ({ toolName, enabled }));
    if (this.repository.setMany) {
      await this.repository.setMany(sessionUuid, entries);
      return;
    }
    for (const entry of entries) {
      await this.repository.set(sessionUuid, entry.toolName, entry.enabled);
    }
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
    throw new Error(
      `Tool '${unknown}' is not a session-configurable tool name; AUTOMOBILE_ENABLED_TOOLS/AUTOMOBILE_DISABLED_TOOLS accept session-configurable tools only (see the automobile:tools resource).`,
    );
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
    throw new Error(
      `Tool '${unknown}' is not a session-configurable tool name; AUTOMOBILE_ENABLED_TOOLS/AUTOMOBILE_DISABLED_TOOLS accept session-configurable tools only (see the automobile:tools resource).`,
    );
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
let includeEnvironmentDefaults = true;

export function configureToolSelectionCliDefaults(
  enabledTools: readonly string[],
  disabledTools: readonly string[],
  options: { includeEnvironment?: boolean } = {},
): void {
  configuredEnabledTools = [...enabledTools];
  configuredDisabledTools = [...disabledTools];
  includeEnvironmentDefaults = options.includeEnvironment ?? true;
  defaultService = undefined;
}

export function validateConfiguredToolSelectionDefaults(
  knownToolNames: ReadonlySet<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  getStartupToolDefaults(
    includeEnvironmentDefaults ? environment : {},
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
        includeEnvironmentDefaults ? process.env : {},
        knownToolNames,
        configuredEnabledTools,
        configuredDisabledTools,
      ),
    );
  }
  return defaultService;
}
