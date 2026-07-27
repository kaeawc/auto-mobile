/** Tool capabilities that are intentionally absent from the baseline MCP surface. */
export const TOOL_CAPABILITIES = [
  "clipboard",
  "advanced-interaction",
  "app-permissions",
  "device-settings",
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

/** Core navigation and device lifecycle are always available. */
export const DEFAULT_TOOL_CAPABILITIES: ReadonlySet<ToolCapability> = new Set();

export interface SessionToolProfileRepository {
  list(sessionUuid: string): Promise<Map<string, boolean>>;
  set(sessionUuid: string, capability: string, enabled: boolean): Promise<void>;
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
      return DEFAULT_TOOL_CAPABILITIES.has(capability);
    }
    const overrides = await this.repository.list(sessionUuid);
    return overrides.get(capability) ?? this.environmentDefaults.has(capability);
  }

  async setEnabled(sessionUuid: string, capability: ToolCapability, enabled: boolean): Promise<void> {
    await this.repository.set(sessionUuid, capability, enabled);
  }
}

let defaultService: SessionToolProfileService | undefined;

export function getSessionToolProfileService(): SessionToolProfileService {
  if (!defaultService) {
    // Lazy import avoids opening the production database until the server does.
    const { SqliteSessionToolProfileRepository } = require("./SqliteSessionToolProfileRepository");
    const raw = process.env.AUTOMOBILE_TOOLSET_DEFAULTS ?? "";
    const defaults = new Set(raw.split(",").map(value => value.trim()).filter(value => TOOL_CAPABILITIES.includes(value as ToolCapability)));
    for (const capability of TOOL_CAPABILITIES) {
      const env = `AUTOMOBILE_TOOLSET_${capability.toUpperCase().replace(/-/g, "_")}`;
      if (process.env[env] === "1") { defaults.add(capability); }
    }
    defaultService = new SessionToolProfileService(new SqliteSessionToolProfileRepository(), defaults);
  }
  return defaultService;
}
