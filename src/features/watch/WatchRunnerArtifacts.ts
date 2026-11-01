import { access } from "node:fs/promises";
import { join } from "node:path";
import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { ENV, readEnvTrimmed } from "../../config/env";
import { ActionableError } from "../../models/ActionableError";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { runWithAbortSignal } from "../../utils/AbortContext";

/** Finds local watch artifacts, building the checked-in watch scheme when necessary. */
export class WatchRunnerArtifacts {
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
      this.dependencies.override ?? (() => readEnvTrimmed(ENV.WATCH_RUNNER_XCTESTRUN))
    )();
    if (override) {
      await (this.dependencies.access ?? access)(override);
      return override;
    }
    const builder = this.dependencies.builder;
    const existing = await builder.getXctestrunPath("watchSimulator");
    if (existing) {
      return existing;
    }
    const paths = builder.getConfig();
    return await this.builds.run(
      paths.derivedDataPath,
      async (buildSignal) =>
        await runWithAbortSignal(buildSignal, async () => {
          await (this.dependencies.xcodebuild ?? new XcodebuildClient()).executeCommand(
            [
              "build-for-testing",
              "-project",
              join(paths.projectRoot, "ios", "control-proxy", "CtrlProxy.xcodeproj"),
              "-scheme",
              "CtrlProxyWatch",
              "-destination",
              "generic/platform=watchOS Simulator",
              "-derivedDataPath",
              paths.derivedDataPath,
              "CODE_SIGNING_ALLOWED=NO",
            ],
            { signal: buildSignal, timeoutMs: 120_000 },
          );
          const built = await builder.getXctestrunPath("watchSimulator");
          if (!built) {
            throw new ActionableError(
              `No watchsimulator xctestrun found in ${paths.derivedDataPath}/Build/Products after building CtrlProxyWatch; set ${ENV.WATCH_RUNNER_XCTESTRUN.name} to a prebuilt watch runner.`,
            );
          }
          return built;
        }),
      signal,
      { cancelWhenAllWaitersAbort: true },
    );
  }
}
