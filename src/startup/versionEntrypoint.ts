import { getGlobalVersionOutput } from "../cli/versionFlag";

/**
 * The global `--version`/`-v` entrypoint. `src/index.ts` dispatches here before it loads the
 * server graph (the boot admission and CtrlProxy wirings, the logger, startup), so printing the
 * version only pays for the environment bootstrap and the version resolver (#17684).
 */
export interface VersionEntrypointDeps {
  /** Same PATH/ANDROID_HOME bootstrap the server path runs: the git stamp probe spawns `git`. */
  bootstrapEnvironment(): void;
  resolveVersion(): Promise<string>;
  log(message: string | undefined): void;
  exit(code: number): void;
}

const defaultVersionEntrypointDeps = async (): Promise<VersionEntrypointDeps> => {
  const { bootstrapEnvironment } = await import("../utils/envBootstrap");
  return {
    bootstrapEnvironment: () => bootstrapEnvironment(),
    resolveVersion: async () => {
      const { getSettledMcpServerVersion } = await import("../utils/mcpVersion");
      return getSettledMcpServerVersion();
    },
    log: (message) => console.log(message),
    exit: (code) => process.exit(code),
  };
};

/** Print the settled (dirty-aware) version for a global version flag, then exit 0. */
export async function runVersionEntrypoint(
  args: string[],
  deps?: VersionEntrypointDeps,
): Promise<void> {
  const resolved = deps ?? (await defaultVersionEntrypointDeps());
  resolved.bootstrapEnvironment();
  const versionOutput = getGlobalVersionOutput(args, await resolved.resolveVersion());
  resolved.log(versionOutput);
  resolved.exit(0);
}
