import type { FeatureFlagKey } from "../models/FeatureFlagDefinitions";
import {
  isAndroidOrIosPlatform,
  PLATFORM_LABELS,
  type NonIosApplePlatform,
  type Platform,
} from "../models/Platform";
import { APPLE_PLATFORM_SUPPORTED_TOOLS } from "./applePlatformToolSupport";

/**
 * One thing a tool needs before it can run (#18141):
 * - `sdkEmbed`: the daemon runs with `--embedded-sdk` (the registry's embedded-SDK gate).
 * - `debugBuild`: the daemon runs in debug mode (the registry's `debug` gate).
 * - `featureFlag:<key>`: some or all calls are refused while that feature flag is off.
 * - `platform:<platform>`: the tool can drive a device on that platform. A tool with no platform
 *   entry looks up its own target or needs no device.
 */
export type ToolRequirement =
  | "sdkEmbed"
  | "debugBuild"
  | `featureFlag:${FeatureFlagKey}`
  | `platform:${Platform}`;

/** Where a tool definition advertises its requirements (always present, possibly empty). */
export const TOOL_REQUIREMENTS_META_KEY = "automobile/requires";

/** Every platform, in the order requirements list them. */
const PLATFORM_ORDER = Object.keys(PLATFORM_LABELS) as Platform[];

/** The registration facts the requirements are derived from: each is a runtime gate. */
export interface ToolRequirementSource {
  name: string;
  /** Device-aware: dispatched through the registry's platform gate. */
  requiresDevice?: boolean;
  embeddedSdkOnly?: boolean;
  debugOnly?: boolean;
  /** Feature flags whose refusal the tool's handler returns (`featureFlagDisabledMessage`). */
  featureFlags?: readonly FeatureFlagKey[];
}

type PlatformTable = Readonly<Record<NonIosApplePlatform, ReadonlySet<string>>>;

/**
 * The platform values a tool's advertised input schema accepts for `platform`, or undefined when
 * the schema does not constrain it. Schema validation refuses any other value before dispatch.
 */
function schemaPlatformVocabulary(inputSchema: Record<string, unknown>): Set<string> | undefined {
  const properties = inputSchema.properties as Record<string, unknown> | undefined;
  const field = properties?.platform as { enum?: unknown; const?: unknown } | undefined;
  if (Array.isArray(field?.enum)) {
    return new Set(field.enum.filter((value): value is string => typeof value === "string"));
  }
  return typeof field?.const === "string" ? new Set([field.const]) : undefined;
}

/**
 * The platforms a device-aware tool can drive: those the registry's platform gate admits
 * (`assertToolSupportsDevicePlatform`: Android and iOS always, other Apple platforms by opting in
 * to `APPLE_PLATFORM_SUPPORTED_TOOLS`), narrowed to the input schema's `platform` vocabulary.
 */
function devicePlatforms(
  name: string,
  inputSchema: Record<string, unknown>,
  supportedTools: PlatformTable,
): Platform[] {
  const vocabulary = schemaPlatformVocabulary(inputSchema);
  return PLATFORM_ORDER.filter(
    (platform) =>
      (isAndroidOrIosPlatform(platform) || supportedTools[platform].has(name)) &&
      (vocabulary === undefined || vocabulary.has(platform)),
  );
}

/** Derive a tool's requirements from its runtime gates, in a stable order. */
export function deriveToolRequirements(
  tool: ToolRequirementSource,
  inputSchema: Record<string, unknown>,
  supportedTools: PlatformTable = APPLE_PLATFORM_SUPPORTED_TOOLS,
): ToolRequirement[] {
  const requirements: ToolRequirement[] = [];
  if (tool.embeddedSdkOnly) {
    requirements.push("sdkEmbed");
  }
  if (tool.debugOnly) {
    requirements.push("debugBuild");
  }
  for (const flag of [...new Set(tool.featureFlags ?? [])].sort()) {
    requirements.push(`featureFlag:${flag}`);
  }
  if (tool.requiresDevice) {
    for (const platform of devicePlatforms(tool.name, inputSchema, supportedTools)) {
      requirements.push(`platform:${platform}`);
    }
  }
  return requirements;
}
