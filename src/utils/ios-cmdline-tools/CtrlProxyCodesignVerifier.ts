import { runExecSeam } from "../ExecSeam";
import { execFileAsync as sharedExecFileAsync } from "../HostCommandExecutor";

/**
 * Result of running `codesign`/`spctl` against the downloaded CtrlProxy runner
 * app bundle. This is a pure inspection result — the policy decision (warn vs.
 * refuse) lives in {@link IosCtrlProxyBuilder}, not here (issue #4760).
 */
export interface CodesignVerificationOutcome {
  /** `codesign --verify --deep --strict` exited 0 (signature intact). */
  verified: boolean;
  /**
   * `spctl --assess` (Gatekeeper/notarization) result. `null` when the assess
   * step was not run or could not produce a definitive answer — notarization is
   * not expected for a simulator/dev build, so a `null` here is not a failure.
   */
  notarized: boolean | null;
  /** Parsed `TeamIdentifier` from `codesign -dvv`, or `null` when unsigned/absent. */
  teamId: string | null;
  /** Human-readable detail (tool stderr summaries) for logging on failure. */
  detail: string;
}

/**
 * Narrow seam over the macOS `codesign`/`spctl` command-line tools, used as the
 * second integrity control before launching the downloaded iOS helper (issue
 * #4760). Injected into {@link IosCtrlProxyBuilder} so unit tests can supply a
 * fake and never spawn a real process.
 */
export interface CtrlProxyCodesignVerifier {
  verifyAppBundle(appBundlePath: string): Promise<CodesignVerificationOutcome>;
}

/** Result of a single `codesign`/`spctl` invocation via the exec seam. */
export interface CodesignExecOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * argv-only exec seam. Never receives a shell string — the app bundle path is
 * passed as a single literal argument so it cannot be interpolated into a
 * command. Resolves with the exit code (rather than throwing) because both
 * `codesign --verify` and `spctl --assess` signal failure via a non-zero exit.
 */
export type CodesignExec = (file: string, args: readonly string[]) => Promise<CodesignExecOutput>;

const CODESIGN = "codesign";
const SPCTL = "spctl";

const defaultExec: CodesignExec = async (file, args) => {
  try {
    const result = await runExecSeam(
      (options) => sharedExecFileAsync(file, [...args], options),
      { maxBuffer: 16 * 1024 * 1024 },
      { command: file, args: [...args] },
      { preserveError: true },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    // This verifier reports command failures as structured outcomes for the caller.
    const commandError = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof commandError.code === "number" ? commandError.code : 1,
      stdout: String(commandError.stdout ?? ""),
      stderr: String(commandError.stderr ?? ""),
    };
  }
};

const TEAM_ID_PATTERN = /^TeamIdentifier=(.+)$/m;

/** Parse `TeamIdentifier=...` out of `codesign -dvv` output (which prints to stderr). */
export function parseTeamIdentifier(codesignDisplayOutput: string): string | null {
  const match = TEAM_ID_PATTERN.exec(codesignDisplayOutput);
  if (!match) {
    return null;
  }
  const value = match[1].trim();
  // `codesign` prints `TeamIdentifier=not set` for ad-hoc / unsigned bundles.
  if (value.length === 0 || value.toLowerCase() === "not set") {
    return null;
  }
  return value;
}

/**
 * Default production verifier. Runs, in order:
 *   1. `codesign --verify --deep --strict <app>` — signature integrity.
 *   2. `codesign -dvv <app>` — to read the Team ID (display goes to stderr).
 *   3. `spctl --assess --type execute <app>` — notarization/Gatekeeper.
 *
 * Each step is best-effort at this layer: the outcome is reported structurally
 * and the launch-gate policy (warn by default, refuse under an opt-in flag)
 * is applied by the caller.
 */
export class DefaultCtrlProxyCodesignVerifier implements CtrlProxyCodesignVerifier {
  constructor(private readonly exec: CodesignExec = defaultExec) {}

  public async verifyAppBundle(appBundlePath: string): Promise<CodesignVerificationOutcome> {
    const verify = await this.exec(CODESIGN, ["--verify", "--deep", "--strict", appBundlePath]);
    const verified = verify.code === 0;

    const display = await this.exec(CODESIGN, ["-dvv", appBundlePath]);
    // `codesign -dvv` prints its human-readable dump to stderr.
    const teamId = parseTeamIdentifier(`${display.stderr}\n${display.stdout}`);

    const assess = await this.exec(SPCTL, ["--assess", "--type", "execute", appBundlePath]);
    const notarized = assess.code === 0 ? true : false;

    const detailParts: string[] = [];
    if (!verified && verify.stderr.trim().length > 0) {
      detailParts.push(`codesign: ${verify.stderr.trim()}`);
    }
    if (!notarized && assess.stderr.trim().length > 0) {
      detailParts.push(`spctl: ${assess.stderr.trim()}`);
    }

    return {
      verified,
      notarized,
      teamId,
      detail: detailParts.join(" | "),
    };
  }
}
