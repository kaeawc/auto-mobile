import { access } from "node:fs/promises";
import { join } from "node:path";
import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { ENV, readEnvTrimmed } from "../../config/env";
import { ActionableError } from "../../models/ActionableError";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";

/** Finds local tvos artifacts, building the checked-in tvos scheme when necessary. */
export class TvosRunnerArtifacts {
  private readonly builds = new SingleFlight<string, string>();
  constructor(
    private readonly dependencies: {
      builder: Pick<IosCtrlProxyBuilder, "getXctestrunPath"> & {
        getConfig(): Pick<
          ReturnType<IosCtrlProxyBuilder["getConfig"]>,
          "projectRoot" | "derivedDataPath"
        >;
      };
      xcodebuild?: Pick<Xcodebuild, "executeCommand">;
      override?: () => string | undefined;
      access?: (file: string) => Promise<unknown>;
    },
  ) {}

  async resolve(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const override = (
      this.dependencies.override ?? (() => readEnvTrimmed(ENV.TVOS_RUNNER_XCTESTRUN))
    )();
    if (override) {
      const resolvedOverride = resolvePathFromDaemonLaunchWorkingDirectory(override);
      await (this.dependencies.access ?? access)(resolvedOverride);
      return resolvedOverride;
    }
    const builder = this.dependencies.builder;
    const existing = await builder.getXctestrunPath("tvSimulator");
    if (existing) {
      return existing;
    }
    const paths = builder.getConfig();
    return await this.builds.run(
      paths.derivedDataPath,
      async (buildSignal) =>
        await runWithAbortSignal(buildSignal, async () => {
          const projectPath = join(
            paths.projectRoot,
            "ios",
            "control-proxy",
            "CtrlProxy.xcodeproj",
          );
          try {
            await (this.dependencies.access ?? access)(projectPath);
          } catch (cause) {
            throw new ActionableError(
              `Tvos runner project is unavailable; set ${ENV.TVOS_RUNNER_XCTESTRUN.name} to a prebuilt tvos runner xctestrun. The published package does not include the tvos project.`,
              { cause },
            );
          }
          await (this.dependencies.xcodebuild ?? new XcodebuildClient()).executeCommand(
            [
              "build-for-testing",
              "-project",
              projectPath,
              "-scheme",
              "AutoMobileTVTest",
              "-destination",
              "generic/platform=tvOS Simulator",
              "-derivedDataPath",
              paths.derivedDataPath,
              "CODE_SIGNING_ALLOWED=NO",
            ],
            { signal: buildSignal, timeoutMs: 120_000 },
          );
          const built = await builder.getXctestrunPath("tvSimulator");
          if (!built) {
            throw new ActionableError(
              `No appletvsimulator xctestrun found in ${paths.derivedDataPath}/Build/Products after building AutoMobileTVTest; set ${ENV.TVOS_RUNNER_XCTESTRUN.name} to a prebuilt tvos runner.`,
            );
          }
          return built;
        }),
      signal,
      { cancelWhenAllWaitersAbort: true },
    );
  }
}
