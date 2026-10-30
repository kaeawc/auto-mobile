import {
  canonicalEnvironmentInputs,
  canonicalInputEntries,
  hashRecords,
  type InputEntry,
} from "./inputCanonical";

export const TIER2_INPUT_HASH_ALGORITHM = "tier2-android-tree-env-sha256-v1";
export const TIER3_INPUT_HASH_ALGORITHM = "tier3-ios-tree-env-sha256-v1";

/**
 * Variables the Gradle build, its tests and the Kotlin code under test read (#11977), found by
 * scanning `android/` for `System.getenv`, `getenv` and `providers.environmentVariable`. A
 * bats test repeats the scan, so a new read must be listed here or in the exclusions below.
 */
export const TIER2_CONSUMED_ENV: readonly string[] = [
  "ANDROID_TARGET_SDK",
  "APP_VERSION",
  "AUTOMOBILE_APP_VERSION",
  "AUTOMOBILE_DAEMON_FORCE_RESTART",
  "AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH",
  "AUTOMOBILE_DAEMON_PACKAGE_VERSION",
  "AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS",
  "AUTOMOBILE_EXECUTE_PLAN_CLEANUP_APP_ID",
  "AUTOMOBILE_EXECUTE_PLAN_CLEANUP_CLEAR_APP_DATA",
  "AUTOMOBILE_TARGET_SDK",
  "AUTOMOBILE_VERSION",
  "AUTO_MOBILE_DAEMON_STARTUP_TIMEOUT_MS",
  "PROTOTYPE_SCROLL_MEASURE",
];

/**
 * Read by the Android build but deliberately not hashed: where a host keeps things (a path
 * differing between machines does not change a result), the commit stamp (the commit is already
 * the attestation's subject), CI context, the release-only switch that fails incomplete signing
 * configurations without changing the bytes of a build that completes, and secrets, which must
 * never reach a hash input.
 */
export const TIER2_EXCLUDED_ENV: readonly string[] = [
  "ANDROID_HOME",
  "ANDROID_SDK_HOME",
  "ANDROID_SDK_ROOT",
  "ANTHROPIC_API_KEY",
  "AUTOMOBILE_CTRL_PROXY_APK_PATH",
  "AUTOMOBILE_FIXTURE_OUT_DIR",
  "AUTOMOBILE_GIT_COMMIT",
  "BUN_INSTALL",
  "CI",
  "CI_COMMIT_SHA",
  "GITHUB_SHA",
  "GIT_COMMIT",
  "GOOGLE_API_KEY",
  "HOME",
  "MACOS_DEVELOPER_ID_SIGNING_IDENTITY",
  "MACOS_SIGN",
  "OPENAI_API_KEY",
  "PATH",
  "PATHEXT",
  "PROJECT_ROOT",
  "PROTOTYPE_SCROLL_MEASURE_OUT",
  "PROTOVIEWER_REQUIRE_RELEASE_SIGNING",
  "RELEASE_KEYSTORE_PASSWORD",
  "RELEASE_KEYSTORE_PATH",
  "RELEASE_KEY_ALIAS",
  "RELEASE_KEY_PASSWORD",
];

/** Variables that choose the Xcode toolchain or the pinned XcodeGen the iOS lane builds with. */
export const TIER3_CONSUMED_ENV: readonly string[] = [
  "DEVELOPER_DIR",
  "TOOLCHAINS",
  "XCODEGEN_VERSION",
];

export interface LaneHashInputs {
  entries: readonly InputEntry[];
  host: { os: string; arch: string };
  env: Readonly<Record<string, string | undefined>>;
}

function laneHash(
  algorithm: string,
  consumedEnv: readonly string[],
  inputs: LaneHashInputs,
): string {
  const entries = canonicalInputEntries(inputs.entries).map(({ path, id, mode }) => [
    path,
    id,
    mode,
  ]);
  return hashRecords(algorithm, [
    ["entries", entries],
    ["host", inputs.host.os, inputs.host.arch],
    ["env", canonicalEnvironmentInputs(inputs.env, consumedEnv)],
  ]);
}

/**
 * Tier 2 (Gradle: Android, desktop, IntelliJ plugin): every tracked input under `android/`, the
 * Gradle wrapper, version catalog and build scripts among them, plus OS, CPU architecture and the
 * variables above. JDK, Gradle and AGP versions are the validators' environment match, not part
 * of the hash. Gradle's own build-cache keys exist only after a build runs, so they cannot be
 * recomputed by CI before the job; the tree is the over-inclusive stand-in.
 */
export function tier2InputHash(inputs: LaneHashInputs): string {
  return laneHash(TIER2_INPUT_HASH_ALGORITHM, TIER2_CONSUMED_ENV, inputs);
}

/**
 * Tier 3 (XcodeGen and xcodebuild): every tracked input under `ios/`, the XcodeGen specs
 * (`project.yml`) among them, plus OS, CPU architecture and the toolchain-selecting variables.
 * Xcode, macOS and XcodeGen versions are the validators' environment match. The generated
 * project is not an input; its reproducibility is #3975.
 */
export function tier3InputHash(inputs: LaneHashInputs): string {
  return laneHash(TIER3_INPUT_HASH_ALGORITHM, TIER3_CONSUMED_ENV, inputs);
}
