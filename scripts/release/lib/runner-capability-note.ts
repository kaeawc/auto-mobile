/**
 * Pure logic for the advisory runner-capability note (#17618): capabilities a change newly
 * advertises from control-proxy sources and that the same change newly gates on in host code.
 * Reuses the release gate's parsers so the note and the gate agree on what counts.
 */
import {
  type ArtifactId,
  gatedByScans,
  parseAndroidAdvertised,
  parseIosRunnerAdvertised,
  scanHostGates,
} from "./artifact-capabilities";

/** Artifacts built from `android/control-proxy/` and `ios/control-proxy/`. */
export const RUNNER_ARTIFACTS = [
  "android-ctrlproxy-apk",
  "ios-runner",
] as const satisfies readonly ArtifactId[];
export type RunnerArtifact = (typeof RUNNER_ARTIFACTS)[number];

const RUNNER_PARSERS: Record<RunnerArtifact, (source: string) => string[]> = {
  "android-ctrlproxy-apk": parseAndroidAdvertised,
  "ios-runner": parseIosRunnerAdvertised,
};

/** Concatenated advertising sources of one runner artifact on each side of the diff. */
export type RunnerSources = Record<RunnerArtifact, { base: string; current: string }>;

/** Contents of one changed host file at the merge-base and in the working tree ("" when absent). */
export interface HostFileSides {
  base: string;
  current: string;
}

function difference(current: string[], base: string[]): string[] {
  const before = new Set(base);
  return [...new Set(current)].filter((name) => !before.has(name)).sort();
}

/**
 * Capabilities each runner artifact advertises in the working tree but did not at the merge-base,
 * computed per artifact so adding an existing iOS capability to Android (or back) still counts.
 */
export function newRunnerCapabilities(sources: RunnerSources): string[] {
  return [
    ...new Set(
      RUNNER_ARTIFACTS.flatMap((artifact) =>
        difference(
          RUNNER_PARSERS[artifact](sources[artifact].current),
          RUNNER_PARSERS[artifact](sources[artifact].base),
        ),
      ),
    ),
  ].sort();
}

function gatedBy(sources: string[], context: string[]): string[] {
  const scans = sources.map(scanHostGates);
  const declared = Object.assign(
    {},
    ...context.map((source) => scanHostGates(source).declared),
    ...scans.map((scan) => scan.declared),
  ) as Record<string, string>;
  return gatedByScans(scans, declared);
}

/**
 * Capability gates (AST-scanned, comments never count) present in the working-tree versions of the
 * changed host files but not in their merge-base versions. `context` holds unchanged host sources
 * that only contribute constant declarations (e.g. a shared capabilities module), so a new
 * reference to an existing constant resolves; their own uses never count as new.
 */
export function newHostGates(files: HostFileSides[], context: string[] = []): string[] {
  return difference(
    gatedBy(
      files.map((file) => file.current),
      context,
    ),
    gatedBy(
      files.map((file) => file.base),
      context,
    ),
  );
}

/** New runner capabilities that new host code already gates on. */
export function unreleasedRunnerCapabilitiesInUse(
  sources: RunnerSources,
  hostFiles: HostFileSides[],
  context: string[] = [],
): string[] {
  const runnerNew = newRunnerCapabilities(sources);
  if (runnerNew.length === 0) {
    return [];
  }
  const hostGates = new Set(newHostGates(hostFiles, context));
  return runnerNew.filter((name) => hostGates.has(name));
}
