import { access } from "node:fs/promises";
import {
  CTRL_PROXY_PROJECT_RELATIVE_PATH,
  locateCtrlProxyProject,
  type CtrlProxyProjectLocatorDependencies,
} from "../../ctrlProxy/CtrlProxyProjectLocator";
import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { ENV, readEnvTrimmed } from "../../config/env";
import { ActionableError } from "../../models/ActionableError";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";

const WATCH_SCHEME = "CtrlProxyWatch";

/** Resolves overrides, local products, and released watch runners before building from source. */
export class WatchRunnerArtifacts {
  private readonly builds = new SingleFlight<string, string>();
  constructor(
    private readonly dependencies: {
      builder: Pick<IosCtrlProxyBuilder, "getXctestrunPath"> &
        Partial<Pick<IosCtrlProxyBuilder, "runExclusiveOnDerivedData">> & {
          getConfig(): Pick<
            ReturnType<IosCtrlProxyBuilder["getConfig"]>,
            "projectRoot" | "derivedDataPath"
          >;
        };
      release?: { ensure(signal?: AbortSignal): Promise<string | null> };
      xcodebuild?: Pick<Xcodebuild, "executeCommand">;
      override?: () => string | undefined;
      access?: (file: string) => Promise<unknown>;
      projectLocator?: Omit<CtrlProxyProjectLocatorDependencies, "access">;
    },
  ) {}

  async resolve(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const override = (
      this.dependencies.override ?? (() => readEnvTrimmed(ENV.WATCH_RUNNER_XCTESTRUN))
    )();
    if (override) {
      const resolvedOverride = resolvePathFromDaemonLaunchWorkingDirectory(override);
      await (this.dependencies.access ?? access)(resolvedOverride);
      return resolvedOverride;
    }
    const builder = this.dependencies.builder;
    const existing = await builder.getXctestrunPath("watchSimulator");
    if (existing) {
      return existing;
    }
    const released = await this.dependencies.release?.ensure(signal);
    signal?.throwIfAborted();
    if (released) {
      return released;
    }
    const paths = builder.getConfig();
    return await this.builds.run(
      paths.derivedDataPath,
      async (buildSignal) =>
        await runWithAbortSignal(buildSignal, async () => {
          const build = async () => {
            buildSignal?.throwIfAborted();
            const location = await locateCtrlProxyProject(paths.projectRoot, {
              ...this.dependencies.projectLocator,
              access: this.dependencies.access,
            });
            if (!location.found) {
              throw missingProjectError(location.checked, paths.derivedDataPath);
            }
            const projectPath = location.projectPath;
            await (this.dependencies.xcodebuild ?? new XcodebuildClient()).executeCommand(
              [
                "build-for-testing",
                "-project",
                projectPath,
                "-scheme",
                WATCH_SCHEME,
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
                `No watchsimulator xctestrun found in ${paths.derivedDataPath}/Build/Products after building ${WATCH_SCHEME}; set ${ENV.WATCH_RUNNER_XCTESTRUN.name} to a prebuilt watch runner.`,
              );
            }
            return built;
          };
          return builder.runExclusiveOnDerivedData
            ? await builder.runExclusiveOnDerivedData(build)
            : await build();
        }),
      signal,
      { cancelWhenAllWaitersAbort: true },
    );
  }
}

function buildCommand(projectPath: string, derivedDataPath: string): string {
  return `xcodebuild build-for-testing -project ${projectPath} -scheme ${WATCH_SCHEME} -destination 'generic/platform=watchOS Simulator' -derivedDataPath ${derivedDataPath} CODE_SIGNING_ALLOWED=NO`;
}

/** Names every place searched and each way to supply the runner (#17285). */
function missingProjectError(checked: string[], derivedDataPath: string): ActionableError {
  return new ActionableError(
    [
      `The ${WATCH_SCHEME} watch runner is not built in ${derivedDataPath} and ${CTRL_PROXY_PROJECT_RELATIVE_PATH} was not found at: ${checked.join(", ")}.`,
      `From an AutoMobile checkout, set ${ENV.PROJECT_ROOT.name} to the checkout root and retry startDevice to build it automatically,`,
      `or build it yourself: ${buildCommand(`<checkout>/${CTRL_PROXY_PROJECT_RELATIVE_PATH}`, derivedDataPath)}.`,
      `This release has no published watchOS runner, and the published package does not include the watch project; there, set ${ENV.WATCH_RUNNER_XCTESTRUN.name} to a prebuilt watch runner xctestrun.`,
    ].join(" "),
  );
}
