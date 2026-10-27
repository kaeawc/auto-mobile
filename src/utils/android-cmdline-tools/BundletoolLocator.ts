import { join } from "path";
import { AMBIENT_ENV, ENV, readEnvTrimmed } from "../../config/env";
import { DefaultSystemDetection, type SystemDetection } from "../system/SystemDetection";
import { BundletoolNotFoundError } from "./BundletoolNotFoundError";
import { getToolPathFromPath } from "./detection";

export { BUNDLETOOL_INSTALL_STEPS, BundletoolNotFoundError } from "./BundletoolNotFoundError";

/** How to start bundletool: `file` with `args` prepended to every bundletool argv. */
export interface BundletoolCommand {
  file: string;
  args: string[];
  /** The bundletool executable or jar, for diagnostics. */
  location: string;
  source: "jar" | "path";
}

export type BundletoolLookup =
  | { found: true; command: BundletoolCommand }
  | { found: false; reason: string };

export interface BundletoolLocator {
  locate(): Promise<BundletoolLookup>;
}

/**
 * Finds bundletool without downloading it: an explicit jar (`AUTOMOBILE_BUNDLETOOL_JAR`, run
 * with `JAVA_HOME/bin/java` or `java` on PATH) wins, then a `bundletool` launcher on PATH (the
 * Homebrew formula installs one).
 */
export class DefaultBundletoolLocator implements BundletoolLocator {
  constructor(
    private readonly systemDetection: SystemDetection = new DefaultSystemDetection(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async locate(): Promise<BundletoolLookup> {
    const jar = readEnvTrimmed(ENV.BUNDLETOOL_JAR, this.env);
    if (jar !== undefined) {
      return this.locateJar(jar);
    }
    const launcher = await getToolPathFromPath("bundletool", this.systemDetection);
    if (launcher) {
      return {
        found: true,
        command: { file: launcher, args: [], location: launcher, source: "path" },
      };
    }
    return {
      found: false,
      reason: `bundletool is not on PATH and ${ENV.BUNDLETOOL_JAR.name} is not set`,
    };
  }

  private async locateJar(jar: string): Promise<BundletoolLookup> {
    if (!this.systemDetection.fileExistsSync(jar)) {
      return {
        found: false,
        reason: `${ENV.BUNDLETOOL_JAR.name} points at a missing file: ${jar}`,
      };
    }
    const java = await this.locateJava();
    if (!java) {
      return {
        found: false,
        reason: `${ENV.BUNDLETOOL_JAR.name} is set but no java was found (JAVA_HOME/bin/java or java on PATH)`,
      };
    }
    return {
      found: true,
      command: { file: java, args: ["-jar", jar], location: jar, source: "jar" },
    };
  }

  private async locateJava(): Promise<string | null> {
    const javaHome = readEnvTrimmed(AMBIENT_ENV.JAVA_HOME, this.env);
    if (javaHome !== undefined) {
      const binary = this.systemDetection.getCurrentPlatform() === "win32" ? "java.exe" : "java";
      const candidate = join(javaHome, "bin", binary);
      if (this.systemDetection.fileExistsSync(candidate)) {
        return candidate;
      }
    }
    return getToolPathFromPath("java", this.systemDetection);
  }
}

/** Resolve bundletool or throw the typed, actionable not-found error. */
export async function requireBundletool(
  locator: BundletoolLocator,
  artifactKind: string,
): Promise<BundletoolCommand> {
  const lookup = await locator.locate();
  if (!lookup.found) {
    throw new BundletoolNotFoundError(lookup.reason, artifactKind);
  }
  return lookup.command;
}
