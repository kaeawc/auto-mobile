import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../models/describeUnknownError";
import { logger } from "../utils/logger";
import {
  resolveDaemonLaunchWorkingDirectory,
  resolvePathFromDaemonLaunchWorkingDirectory,
} from "../utils/workingDirectory";

/** The checked-in Xcode project, relative to an AutoMobile checkout root. */
export const CTRL_PROXY_PROJECT_RELATIVE_PATH = join("ios", "control-proxy", "CtrlProxy.xcodeproj");

export interface CtrlProxyProjectLocatorDependencies {
  access?: (file: string) => Promise<unknown>;
  /** Where the daemon was launched from; the detached daemon itself runs in the home directory. */
  launchDirectory?: () => string;
  /** Root of the AutoMobile package this code runs from, when it can be found. */
  packageRoot?: () => string | undefined;
}

export type CtrlProxyProjectLocation =
  | { found: true; projectPath: string; checked: string[] }
  | { found: false; checked: string[] };

/**
 * Finds `ios/control-proxy/CtrlProxy.xcodeproj` for a local runner build.
 *
 * The configured project root alone is not enough: it defaults to the process working
 * directory, and the detached daemon runs in the home directory (#17285). Candidates, in
 * order: the configured root (a relative one anchored at the daemon launch directory),
 * the daemon launch directory, and the root of the AutoMobile package running this code.
 */
export async function locateCtrlProxyProject(
  projectRoot: string,
  dependencies: CtrlProxyProjectLocatorDependencies = {},
): Promise<CtrlProxyProjectLocation> {
  const exists = dependencies.access ?? access;
  const roots = [
    resolvePathFromDaemonLaunchWorkingDirectory(projectRoot),
    (dependencies.launchDirectory ?? (() => resolveDaemonLaunchWorkingDirectory()))(),
    (dependencies.packageRoot ?? defaultPackageRoot)(),
  ].filter((root): root is string => typeof root === "string" && root.length > 0);
  const checked = [...new Set(roots.map((root) => join(root, CTRL_PROXY_PROJECT_RELATIVE_PATH)))];
  for (const projectPath of checked) {
    try {
      await exists(projectPath);
      return { found: true, projectPath, checked };
    } catch (error) {
      // A missing candidate is expected; the caller reports every checked path.
      logger.debug(`CtrlProxy project not at ${projectPath}: ${errorMessage(error)}`);
    }
  }
  return { found: false, checked };
}

let packageRoot: string | null | undefined;

function defaultPackageRoot(): string | undefined {
  if (packageRoot === undefined) {
    let root = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(root, "package.json")) && dirname(root) !== root) {
      root = dirname(root);
    }
    packageRoot = existsSync(join(root, "package.json")) ? root : null;
  }
  return packageRoot ?? undefined;
}
