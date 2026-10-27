import { type AttestationLane, type AttestationPayload } from "./attestationSchema";
import { TIER2_INPUT_HASH_ALGORITHM, TIER3_INPUT_HASH_ALGORITHM } from "./tier23InputHash";
import {
  canonicalEnvironmentInputs,
  canonicalInputEntries,
  hashRecords,
  type InputEntry,
} from "./inputCanonical";

export const TIER1_INPUT_HASH_ALGORITHM = "tier1-node-tree-env-sha256-v1";

/** The input hash algorithm a lane's attestation must carry (#11976, #11977, #11978). */
export function expectedInputHashAlgorithm(lane: AttestationLane): string {
  return {
    node: TIER1_INPUT_HASH_ALGORITHM,
    android: TIER2_INPUT_HASH_ALGORITHM,
    ios: TIER3_INPUT_HASH_ALGORITHM,
  }[lane];
}

/**
 * Environment variables the Turbo tasks read (`env` and `passThroughEnv` in turbo.json, plus the
 * global ones), minus the CI-context markers below. An undeclared variable that changes a task's
 * result would give two results under one key, so a test fails when turbo.json names one that is
 * neither listed here nor excluded below.
 */
export const TIER1_CONSUMED_ENV: readonly string[] = [
  "APK_SHA256_CHECKSUM",
  "AUTOMOBILE_CHANGED_SELECT_TIMEOUT_SECONDS",
  "AUTOMOBILE_COORDINATION_DIR",
  "AUTOMOBILE_HEAVY_CHECK_SLOTS",
  "AUTOMOBILE_HEAVY_CHECK_WAIT_SECONDS",
  "AUTOMOBILE_HOST_TEST_SLOTS",
  "AUTOMOBILE_SOURCEMAP_INCLUDE_DEPS",
  "AUTOMOBILE_SOURCEMAP_STRIP_SOURCES",
  "AUTOMOBILE_TEST_MODE",
  "AUTOMOBILE_TEST_TIMEOUT_MS",
  "AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS",
  "AUTOMOBILE_UNIT_TEST_BASE_REF",
  "AUTOMOBILE_UNIT_TEST_WORKERS",
  "AUTO_MOBILE_COORDINATION_DIR",
  "DEBUG_ADB_EXEC",
  "IOS_CTRL_PROXY_SHA256_CHECKSUM",
  "RELEASE_VERSION",
];

/**
 * Where a local run and a CI run legitimately differ (lint fixes locally and only checks in CI);
 * the tier's trust policy, not the hash, accounts for them.
 */
export const TIER1_CI_CONTEXT_ENV: readonly string[] = ["CI", "GITHUB_ACTIONS", "GITHUB_BASE_REF"];

/**
 * Tasks proven to give the same result on any OS and CPU. Empty: until a task is proven
 * platform-independent, a result from one platform never matches another's.
 */
export const TIER1_PLATFORM_INDEPENDENT_TASKS: readonly string[] = [];

/**
 * What a lane's CI target job runs on, which is what CI recomputes the hash for (#11976 review): the
 * gate itself always runs on one Linux runner, so its own host says nothing about the iOS jobs.
 * `os` and `arch` are Node's names (`process.platform`, `process.arch`) for the runner image. A
 * producer's host is its own measured one, and a producer on another platform never matches.
 */
export const CI_TARGET_PLATFORM: Readonly<Record<AttestationLane, { os: string; arch: string }>> =
  Object.freeze({
    node: { os: "linux", arch: "x64" },
    android: { os: "linux", arch: "x64" },
    ios: { os: "darwin", arch: "arm64" },
  });

/**
 * The consumed variables the target jobs set explicitly; every other consumed variable is unset
 * there. Listing a variable here is what makes a producer that sets the same value match.
 */
export const CI_TARGET_ENV: Readonly<Record<AttestationLane, Readonly<Record<string, string>>>> =
  Object.freeze({ node: {}, android: {}, ios: {} });

export interface HostDescriptor {
  os: string;
  arch: string;
  bunVersion: string | null;
}

export interface Tier1Inputs {
  entries: readonly InputEntry[];
  host: HostDescriptor;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Tier 1 (TypeScript, Bun, Turbo): every tracked input of the lane at the commit, the lockfile
 * among them, plus what the entries cannot see: Bun version, OS, CPU architecture and the
 * variables the tasks read.
 */
export function tier1InputHash(inputs: Tier1Inputs): string {
  const entries = canonicalInputEntries(inputs.entries).map(({ path, id, mode }) => [
    path,
    id,
    mode,
  ]);
  return hashRecords(TIER1_INPUT_HASH_ALGORITHM, [
    ["entries", entries],
    ["host", inputs.host.os, inputs.host.arch, inputs.host.bunVersion],
    ["env", canonicalEnvironmentInputs(inputs.env, TIER1_CONSUMED_ENV)],
    ["platform-independent", [...TIER1_PLATFORM_INDEPENDENT_TASKS].sort()],
  ]);
}

export type PayloadEnvironment = AttestationPayload["environment"];
