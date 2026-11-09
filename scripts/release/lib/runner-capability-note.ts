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

/** Capabilities the working tree advertises that the merge-base did not, across runner artifacts. */
export function newRunnerCapabilities(sources: RunnerSources): string[] {
  return difference(
    RUNNER_ARTIFACTS.flatMap((artifact) => RUNNER_PARSERS[artifact](sources[artifact].current)),
    RUNNER_ARTIFACTS.flatMap((artifact) => RUNNER_PARSERS[artifact](sources[artifact].base)),
  );
}

function gatedBy(sources: string[]): string[] {
  const scans = sources.map(scanHostGates);
  const declared = Object.assign({}, ...scans.map((scan) => scan.declared)) as Record<
    string,
    string
  >;
  return gatedByScans(scans, declared);
}

/**
 * Capability gates (AST-scanned, comments never count) present in the working-tree versions of the
 * changed host files but not in their merge-base versions.
 */
export function newHostGates(files: HostFileSides[]): string[] {
  return difference(
    gatedBy(files.map((file) => file.current)),
    gatedBy(files.map((file) => file.base)),
  );
}

/** New runner capabilities that new host code already gates on. */
export function unreleasedRunnerCapabilitiesInUse(
  sources: RunnerSources,
  hostFiles: HostFileSides[],
): string[] {
  const hostGates = new Set(newHostGates(hostFiles));
  return newRunnerCapabilities(sources).filter((name) => hostGates.has(name));
}
