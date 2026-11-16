import { z } from "zod/v4";
import {
  BUILD_APP_ERROR_CODES,
  BUILD_PLATFORMS,
  BuildApp,
  type BuildAppResult,
} from "../features/build/BuildApp";
import { MAX_BUILD_TIMEOUT_MS } from "../features/build/buildAppTimeout";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { definePlainTool } from "./defineTool";

const buildAppInput = z.object({
  platform: z
    .enum(BUILD_PLATFORMS)
    .describe(
      "Target: ios, tvos, watchos or visionos (simulator SDK via xcodebuild), or android (Gradle)",
    ),
  projectPath: z
    .string()
    .min(1)
    .describe(
      "Apple: a .xcodeproj, a .xcworkspace, or a directory holding exactly one. Android: the Gradle root holding gradlew",
    ),
  scheme: z.string().min(1).optional().describe("Apple: the Xcode scheme to build (required)"),
  configuration: z
    .string()
    .min(1)
    .optional()
    .describe("Apple: build configuration (default Debug)"),
  derivedDataPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Apple: derived data directory (default build/AutoMobileDerivedData beside the project)",
    ),
  simulatorUdid: z
    .string()
    .min(1)
    .optional()
    .describe("Apple: build for this simulator; default is the generic simulator destination"),
  module: z.string().min(1).optional().describe("Android: Gradle module path (default app)"),
  variant: z
    .string()
    .min(1)
    .optional()
    .describe("Android: build variant to assemble (default debug)"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_BUILD_TIMEOUT_MS)
    .optional()
    .describe("Stop the build after this many milliseconds (default 20 minutes, at most 28)"),
});

export const buildAppResultSchema = z.object({
  message: z.string(),
  success: z.boolean(),
  platform: z.enum(BUILD_PLATFORMS),
  artifactPath: z.string().optional(),
  artifactPaths: z.array(z.string()).optional(),
  command: z.array(z.string()).optional(),
  errorCode: z.enum(BUILD_APP_ERROR_CODES).optional(),
  error: z.string().optional(),
  logExcerpt: z.string().optional(),
});

export type BuildAppArgs = z.output<typeof buildAppInput>;
export type BuildAppRunner = Pick<BuildApp, "build">;

function describe(result: BuildAppResult): string {
  return result.success
    ? `Built ${result.platform} app: ${result.artifactPath}. Install it with installApp({"artifactPath": ...}).`
    : `buildApp failed (${result.errorCode}): ${result.error}`;
}

export function createBuildAppHandler(runner: BuildAppRunner = new BuildApp()) {
  return async (args: BuildAppArgs, _progress?: unknown, signal?: AbortSignal) => {
    const result = await runner.build(args, signal);
    return withIsErrorOnFailure(
      createStructuredToolResponse({ message: describe(result), ...result }),
      result.success,
    );
  };
}

const buildAppTool = definePlainTool({
  name: "buildApp",
  description:
    "Build an app from source for a simulator or emulator and return the installable artifact path: xcodebuild for iOS/tvOS/watchOS/visionOS simulator SDKs, Gradle assemble for Android",
  input: buildAppInput,
  options: { defaultEnabled: true, outputSchema: buildAppResultSchema },
});

/** The registered (strict) schema, for wire-contract tests. */
export const buildAppSchema = buildAppTool.schema;

export function registerBuildAppTools(runner?: BuildAppRunner): void {
  buildAppTool.register(undefined, createBuildAppHandler(runner));
}
