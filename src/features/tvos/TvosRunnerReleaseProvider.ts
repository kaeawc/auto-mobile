import {
  resolveTvosRunnerChecksum,
  resolveTvosRunnerUrl,
  TVOS_RUNNER_ARCHIVE_FILENAME,
} from "../../constants/release";
import {
  SimulatorRunnerReleaseProvider,
  type SimulatorRunnerReleaseFileSystem,
  type SimulatorRunnerReleaseProviderDeps,
} from "../shared/SimulatorRunnerReleaseProvider";

export const TVOS_RUNNER_METADATA_FILENAME = "tvos-runner.json";

export type TvosRunnerReleaseFileSystem = SimulatorRunnerReleaseFileSystem;
export type TvosRunnerReleaseProviderDeps = SimulatorRunnerReleaseProviderDeps;

/** Resolves only checksum-pinned tvOS release products; source builds belong to artifact resolution. */
export class TvosRunnerReleaseProvider extends SimulatorRunnerReleaseProvider {
  constructor(deps: TvosRunnerReleaseProviderDeps = {}) {
    super(
      {
        displayName: "tvOS",
        logLabel: "[TVOS_RUNNER]",
        cacheSubdir: "tvos-runner",
        metadataFilename: TVOS_RUNNER_METADATA_FILENAME,
        archiveFilename: TVOS_RUNNER_ARCHIVE_FILENAME,
        sdk: "appletvsimulator",
        resolveChecksum: (env) => resolveTvosRunnerChecksum(env),
        resolveUrl: (env) => resolveTvosRunnerUrl(env),
      },
      deps,
    );
  }
}
