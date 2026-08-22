/** Tool capabilities that are opt-in beyond the baseline MCP surface. */
export const TOOL_CAPABILITIES = [
  "clipboard",
  "advanced-interaction",
  "app-permissions",
  "device-settings",
  "device-control",
  "app-data-interop",
  "notifications",
  "telephony",
  "accessibility-tools",
  "screen-artifacts",
  "test-authoring",
  "network-inspection",
  "app-routing",
  "navigation-modeling",
  "biometric-auth",
] as const;

export type ToolCapability = typeof TOOL_CAPABILITIES[number];

/**
 * Keep the initial MCP surface to core navigation, app-installation, and device
 * manipulation tools. Agents opt into each advanced capability explicitly.
 */
export const DEFAULT_TOOL_CAPABILITIES: ReadonlySet<ToolCapability> = new Set();

export interface SessionToolProfileRepository {
  list(sessionUuid: string): Promise<Map<string, boolean>>;
  set(sessionUuid: string, capability: string, enabled: boolean): Promise<void>;
  deleteSession(sessionUuid: string): Promise<void>;
}

/**
 * Resolves an agent's effective tool profile. Session overrides are persisted;
 * startup environment defaults are only the fallback for previously unseen
 * capabilities, so an explicit per-session choice survives daemon restarts.
 */
export class SessionToolProfileService {
  constructor(
    private readonly repository: SessionToolProfileRepository,
    private readonly environmentDefaults: ReadonlySet<string> = DEFAULT_TOOL_CAPABILITIES,
  ) {}

  async isEnabled(sessionUuid: string | undefined, capability: ToolCapability): Promise<boolean> {
    if (!sessionUuid) {
      // tools/list has no device session before an agent's first device-aware
      // call, so only the process-level default can apply. Do not query the
      // session repository until a session UUID is available.
      return this.environmentDefaults.has(capability);
    }
    const overrides = await this.repository.list(sessionUuid);
    return overrides.get(capability) ?? this.environmentDefaults.has(capability);
  }

  /** Return an explicit session choice without falling back to process defaults. */
  async getOverride(sessionUuid: string, capability: ToolCapability): Promise<boolean | undefined> {
    return (await this.repository.list(sessionUuid)).get(capability);
  }

  async setEnabled(sessionUuid: string, capability: ToolCapability, enabled: boolean): Promise<void> {
    await this.repository.set(sessionUuid, capability, enabled);
  }

  /** Drop overrides once their routing session has been released. */
  async deleteSession(sessionUuid: string): Promise<void> {
    await this.repository.deleteSession(sessionUuid);
  }
}

let defaultService: SessionToolProfileService | undefined;

export function getEnvironmentDefaultToolCapabilities(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlySet<ToolCapability> {
  const raw = environment.AUTOMOBILE_TOOLSET_DEFAULTS?.trim();
  const defaults = raw
    ? new Set(raw.split(",").map(value => value.trim()).filter((value): value is ToolCapability => TOOL_CAPABILITIES.includes(value as ToolCapability)))
    : new Set(DEFAULT_TOOL_CAPABILITIES);
  for (const capability of TOOL_CAPABILITIES) {
    const env = `AUTOMOBILE_TOOLSET_${capability.toUpperCase().replace(/-/g, "_")}`;
    if (environment[env] === "1") { defaults.add(capability); }
  }
  return defaults;
}

export function getSessionToolProfileService(): SessionToolProfileService {
  if (!defaultService) {
    // Lazy import avoids opening the production database until the server does.
    const { SqliteSessionToolProfileRepository } = require("./SqliteSessionToolProfileRepository");
    defaultService = new SessionToolProfileService(
      new SqliteSessionToolProfileRepository(),
      getEnvironmentDefaultToolCapabilities(),
    );
  }
  return defaultService;
}
