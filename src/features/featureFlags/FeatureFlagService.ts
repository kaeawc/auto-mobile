import type {
  FeatureFlagConfig,
  FeatureFlagDefinition,
  FeatureFlagKey,
} from "./FeatureFlagDefinitions";
import {
  FEATURE_FLAG_DEFINITIONS,
  TOOL_DEFINITION_AFFECTING_FLAGS,
} from "./FeatureFlagDefinitions";
import type { FeatureFlagRepository } from "./FeatureFlagRepository";
import { SqliteFeatureFlagRepository } from "./FeatureFlagRepository";
import type { FeatureFlagApplier } from "./FeatureFlagApplier";
import { DefaultFeatureFlagApplier } from "./FeatureFlagApplier";
import type { ToolListChangedNotifier } from "./ToolListChangedNotifier";
import { NoopToolListChangedNotifier } from "./ToolListChangedNotifier";

interface FeatureFlagState {
  key: FeatureFlagKey;
  label: string;
  description: string;
  enabled: boolean;
  config?: FeatureFlagConfig | null;
}

export class FeatureFlagService {
  private static instance: FeatureFlagService | null = null;
  private readonly definitionByKey: Map<FeatureFlagKey, FeatureFlagDefinition>;
  private initialized = false;
  private flagsByKey = new Map<FeatureFlagKey, boolean>();
  private configsByKey = new Map<FeatureFlagKey, FeatureFlagConfig | null>();

  static getInstance(): FeatureFlagService {
    if (!FeatureFlagService.instance) {
      FeatureFlagService.instance = new FeatureFlagService(
        new SqliteFeatureFlagRepository(),
        new DefaultFeatureFlagApplier(),
      );
    }
    return FeatureFlagService.instance;
  }

  constructor(
    private readonly repository: FeatureFlagRepository,
    private readonly applier: FeatureFlagApplier,
    private readonly definitions: FeatureFlagDefinition[] = FEATURE_FLAG_DEFINITIONS,
    private notifier: ToolListChangedNotifier = new NoopToolListChangedNotifier(),
  ) {
    this.definitionByKey = new Map(definitions.map((definition) => [definition.key, definition]));
  }

  /**
   * Wires the MCP-server-backed notifier into the singleton after the server is
   * constructed (see `createMcpServer`). Kept as a setter because `getInstance()`
   * builds the service before the server exists; unit tests inject via the ctor.
   */
  setToolListChangedNotifier(notifier: ToolListChangedNotifier): void {
    this.notifier = notifier;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.repository.ensureFlags(this.definitions);
    const records = await this.repository.listFlags();
    const recordByKey = new Map(records.map((record) => [record.key, record]));

    for (const definition of this.definitions) {
      const record = recordByKey.get(definition.key);
      const enabled = record ? record.enabled : definition.defaultValue;
      const config = record?.config ?? definition.defaultConfig ?? null;
      this.flagsByKey.set(definition.key, enabled);
      this.configsByKey.set(definition.key, config);
      this.applier.apply(definition.key, enabled, config);
    }

    this.initialized = true;
  }

  async listFlags(): Promise<FeatureFlagState[]> {
    await this.initialize();
    return this.definitions.map((definition) => ({
      key: definition.key,
      label: definition.label,
      description: definition.description,
      enabled: this.flagsByKey.get(definition.key) ?? definition.defaultValue,
      config: this.configsByKey.get(definition.key) ?? definition.defaultConfig ?? null,
    }));
  }

  async setFlag(
    key: FeatureFlagKey,
    enabled: boolean,
    config?: FeatureFlagConfig | null,
  ): Promise<FeatureFlagState> {
    await this.initialize();
    const definition = this.definitionByKey.get(key);
    if (!definition) {
      throw new Error(`Unknown feature flag: ${key}`);
    }

    const nextConfig =
      config !== undefined
        ? config
        : (this.configsByKey.get(key) ?? definition.defaultConfig ?? null);

    // Capture the effective value BEFORE mutating so we only notify on an actual
    // change — re-setting a flag to its current value must not emit (issue #2963,
    // "no notification storm"). Reads the same fallback chain as `isEnabled`.
    const previousEnabled = this.flagsByKey.get(key) ?? definition.defaultValue;

    await this.repository.upsertFlag(key, enabled, config);
    this.flagsByKey.set(key, enabled);
    if (config !== undefined) {
      this.configsByKey.set(key, nextConfig);
    }
    this.applier.apply(key, enabled, nextConfig);

    // Runtime toggle of a flag that changes `tools/list` output (outputSchema
    // advertisement or tool availability) must tell caching clients to re-fetch.
    // Startup application happens in `initialize()`, which deliberately does not
    // call this path, so no notification storm before the first `tools/list`.
    // The notifier is best-effort and never throws (see ToolListChangedNotifier),
    // so no guard is needed here — the flag is already committed above regardless.
    if (enabled !== previousEnabled && TOOL_DEFINITION_AFFECTING_FLAGS.has(key)) {
      this.notifier.notifyToolListChanged();
    }

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      enabled,
      config: nextConfig,
    };
  }

  async setFlagConfig(
    key: FeatureFlagKey,
    config: FeatureFlagConfig | null,
  ): Promise<FeatureFlagState> {
    await this.initialize();
    const definition = this.definitionByKey.get(key);
    if (!definition) {
      throw new Error(`Unknown feature flag: ${key}`);
    }

    const enabled = this.flagsByKey.get(key) ?? definition.defaultValue;
    await this.repository.upsertFlag(key, enabled, config);
    this.configsByKey.set(key, config);
    this.applier.apply(key, enabled, config);

    // No tools/list_changed emit here: `enabled` is unchanged, and no member of
    // TOOL_DEFINITION_AFFECTING_FLAGS derives its tools/list output from `config`
    // (all three are pure booleans). Extend this if a config-driven flag ever
    // starts affecting tool definitions. See issue #2963.

    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      enabled,
      config,
    };
  }

  isEnabled(key: FeatureFlagKey): boolean {
    const definition = this.definitionByKey.get(key);
    if (!definition) {
      return false;
    }
    return this.flagsByKey.get(key) ?? definition.defaultValue;
  }
}
