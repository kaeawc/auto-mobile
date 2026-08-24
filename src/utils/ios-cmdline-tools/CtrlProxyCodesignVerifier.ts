import { execFile } from "node:child_process";

/**
 * Result of running `codesign`/`spctl` against the downloaded CtrlProxy runner
 * app bundle. This is a pure inspection result — the policy decision (warn vs.
 * refuse) lives in {@link IOSCtrlProxyBuilder}, not here (issue #4760).
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
 * #4760). Injected into {@link IOSCtrlProxyBuilder} so unit tests can supply a
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

const defaultExec: CodesignExec = (file, args) =>
  new Promise<CodesignExecOutput>((resolve) => {
    execFile(file, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout);
      const err = String(stderr);
      if (error) {
        // execFile surfaces the process exit code on `error.code` when it is a
        // number; a string there is a spawn error (e.g. ENOENT) which we map to
        // a non-zero sentinel so the caller treats it as "did not verify".
        const code =
          typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1;
        resolve({ code, stdout: out, stderr: err });
        return;
      }
      resolve({ code: 0, stdout: out, stderr: err });
    });
  });

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
