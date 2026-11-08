import type { FeatureFlagKey } from "./FeatureFlagDefinitions";

/** Where the IDE plugin lists feature flags. */
export const IDE_FEATURE_FLAG_SETTINGS_PAGE = "Settings > AutoMobile > Feature Flags";

/**
 * The one refusal for a tool call blocked by a disabled feature flag (#16906). It names the
 * headless CLI command and the IDE page, the two operator paths that change a flag; MCP clients
 * have no write path because a flag applies to the whole daemon.
 */
export function featureFlagDisabledMessage(key: FeatureFlagKey, toolName: string): string {
  return (
    `${toolName} is behind the '${key}' feature flag, which is disabled. ` +
    `Enable it with \`auto-mobile --daemon set-feature-flag ${key} true\` ` +
    `or in the IDE plugin under ${IDE_FEATURE_FLAG_SETTINGS_PAGE}, then retry the call.`
  );
}
