import {
  resolveWatchosRunnerChecksum,
  resolveWatchosRunnerUrl,
  WATCHOS_RUNNER_ARCHIVE_FILENAME,
} from "../../constants/release";
import {
  SimulatorRunnerReleaseProvider,
  type SimulatorRunnerReleaseProviderDeps,
} from "../shared/SimulatorRunnerReleaseProvider";

export const WATCHOS_RUNNER_METADATA_FILENAME = "watchos-runner.json";

/** Resolves only checksum-pinned watchOS release products; source builds belong to artifact resolution. */
export class WatchRunnerReleaseProvider extends SimulatorRunnerReleaseProvider {
  constructor(deps: SimulatorRunnerReleaseProviderDeps = {}) {
    super(
      {
        displayName: "watchOS",
        logLabel: "[WATCH_RUNNER]",
        cacheSubdir: "watchos-runner",
        metadataFilename: WATCHOS_RUNNER_METADATA_FILENAME,
        archiveFilename: WATCHOS_RUNNER_ARCHIVE_FILENAME,
        sdk: "watchsimulator",
        resolveChecksum: (env) => resolveWatchosRunnerChecksum(env),
        resolveUrl: (env) => resolveWatchosRunnerUrl(env),
      },
      deps,
    );
  }
}
