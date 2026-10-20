import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { defaultTimer, type Timer } from "../SystemTimer";
import { ActionableError } from "../../models/ActionableError";
import { runExecSeam } from "../ExecSeam";
import { execFileAsync as sharedExecFileAsync, type ExecFileAsync } from "../HostCommandExecutor";

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
  /** A partial inspection (including a failed Team-ID display) must be retried. */
  cacheable?: false;
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
export type CodesignExec = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<CodesignExecOutput>;

export const CTRL_PROXY_CODESIGN_TIMEOUT_MS = 15_000;
export const CTRL_PROXY_SPCTL_TIMEOUT_MS = 15_000;

const CODESIGN = "codesign";
const SPCTL = "spctl";

// Node also sets killed for maxBuffer overflow; it is not a timeout marker alone.
function isCodesignTimeout(error: unknown, elapsedMs: number, timeoutMs: number): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  const killed = "killed" in error && error.killed === true;
  return (
    code === "ETIMEDOUT" ||
    (code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && killed && elapsedMs >= timeoutMs)
  );
}

/** Adapt the shared exec leaf; injectable so error mapping never needs native tools in tests. */
export const createCodesignExec =
  (execFile: ExecFileAsync = sharedExecFileAsync, timer: Timer = defaultTimer): CodesignExec =>
  async (file, args, { timeoutMs }) => {
    const startedAt = timer.now();
    try {
      const result = await runExecSeam(
        (options) => execFile(file, [...args], options),
        { maxBuffer: 16 * 1024 * 1024, timeoutMs },
        { command: file, args: [...args] },
        { preserveError: true },
      );
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (isCodesignTimeout(error, timer.now() - startedAt, timeoutMs)) {
        throw new ActionableError(`${file} ${args[0]} timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      // This verifier reports command failures as structured outcomes for the caller.
      logger.warn(`[CtrlProxyCodesignVerifier] ${file} ${args[0]} failed`, error);
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
  constructor(
    private readonly exec: CodesignExec = createCodesignExec(),
    private readonly timer: Timer = defaultTimer,
  ) {}

  private run(
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<CodesignExecOutput> {
    return raceWithDeadline(() => this.exec(file, args, { timeoutMs }), {
      timer: this.timer,
      timeoutMs,
      label: `${file} ${args[0]}`,
    });
  }

  public async verifyAppBundle(appBundlePath: string): Promise<CodesignVerificationOutcome> {
    const verify = await this.run(
      CODESIGN,
      ["--verify", "--deep", "--strict", appBundlePath],
      CTRL_PROXY_CODESIGN_TIMEOUT_MS,
    );
    const verified = verify.code === 0;

    const display = await this.run(
      CODESIGN,
      ["-dvv", appBundlePath],
      CTRL_PROXY_CODESIGN_TIMEOUT_MS,
    );
    // `codesign -dvv` prints its human-readable dump to stderr.
    const teamId = parseTeamIdentifier(`${display.stderr}\n${display.stdout}`);

    const assess = await this.run(
      SPCTL,
      ["--assess", "--type", "execute", appBundlePath],
      CTRL_PROXY_SPCTL_TIMEOUT_MS,
    );
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
      ...(display.code !== 0 ? { cacheable: false as const } : {}),
    };
  }
}
