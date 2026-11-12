import {
  resolveVisionosRunnerChecksum,
  resolveVisionosRunnerUrl,
  VISIONOS_RUNNER_ARCHIVE_FILENAME,
} from "../../constants/release";
import {
  SimulatorRunnerReleaseProvider,
  type SimulatorRunnerReleaseProviderDeps,
} from "../shared/SimulatorRunnerReleaseProvider";

export const VISIONOS_RUNNER_METADATA_FILENAME = "visionos-runner.json";

/** Resolves only checksum-pinned visionOS release products; source builds belong to artifact resolution. */
export class VisionosRunnerReleaseProvider extends SimulatorRunnerReleaseProvider {
  constructor(deps: SimulatorRunnerReleaseProviderDeps = {}) {
    super(
      {
        displayName: "visionOS",
        logLabel: "[VISIONOS_RUNNER]",
        cacheSubdir: "visionos-runner",
        metadataFilename: VISIONOS_RUNNER_METADATA_FILENAME,
        archiveFilename: VISIONOS_RUNNER_ARCHIVE_FILENAME,
        sdk: "xrsimulator",
        resolveChecksum: (env) => resolveVisionosRunnerChecksum(env),
        resolveUrl: (env) => resolveVisionosRunnerUrl(env),
      },
      deps,
    );
  }
}
