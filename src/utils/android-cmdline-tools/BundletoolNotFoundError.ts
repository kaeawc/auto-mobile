import { ENV } from "../../config/env";
import { ActionableError } from "../../models/ActionableError";

/** The steps a caller can follow to make bundletool available; reused by doctor and installApp. */
export const BUNDLETOOL_INSTALL_STEPS: readonly string[] = [
  "macOS/Linux with Homebrew: brew install bundletool (puts bundletool on PATH)",
  `or download bundletool-all-<version>.jar from https://github.com/google/bundletool/releases and set ${ENV.BUNDLETOOL_JAR.name}=/absolute/path/to/bundletool-all-<version>.jar (needs Java 11+ via JAVA_HOME or java on PATH)`,
  "then read the automobile:host/toolchain resource: its bundletool entry must be available",
];

/** bundletool is required for this artifact but could not be found on the host. */
export class BundletoolNotFoundError extends ActionableError {
  readonly installSteps: readonly string[] = BUNDLETOOL_INSTALL_STEPS;

  constructor(
    readonly reason: string,
    artifactKind: string,
  ) {
    super(
      `bundletool is required to install ${artifactKind} artifacts on Android but was not found: ${reason}. ` +
        `Install it: ${BUNDLETOOL_INSTALL_STEPS.join("; ")}. AutoMobile never downloads bundletool itself.`,
    );
    this.name = "BundletoolNotFoundError";
  }
}
