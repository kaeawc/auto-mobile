import { createHash, randomBytes } from "node:crypto";
import { redactHomeDir } from "./redactPath";

/**
 * macOS host contract for managed iOS simulator continuity (issue #5104).
 *
 * These are the pure decision functions behind the deployment-continuity
 * validation: given the evidence captured for one managed simulator before and
 * after a worker/AutoMobile rollout, classify what actually happened and decide
 * whether continuity was *proven* (and therefore whether the deploy gate should
 * pass). "A successful inventory listing alone is not continuity evidence" — so
 * identity, boot state, responsiveness, reporting, and the CoreSimulator data
 * root are all weighed, not just presence in a device list.
 *
 * The capture side (shelling to `simctl`, reading host identity, etc.) lives in
 * the runbook and the CLI that wraps these functions; keeping the classifier
 * pure is what lets it be unit-tested deterministically and run in CI.
 */

/** Lifecycle state of a managed simulator at a point in time. */
export type SimulatorLifecycleState =
  | "booted"
  | "shutdown"
  | "booting"
  | "shutting-down"
  | "unknown";

/** Whether AutoMobile/worker reporting was observed for the device. */
export type ReportingStatus = "reporting" | "delayed" | "lost" | "unknown";

/**
 * A point-in-time capture of one managed simulator plus the host/worker context
 * needed to prove continuity. Every field in the issue's "Required Pre/Post
 * Deploy Evidence" list is represented so the same shape is captured before and
 * after a deploy.
 */
export interface ContinuitySnapshot {
  /** Simulator UDID (the 8-4-4-4-12 CoreSimulator identity). */
  readonly udid: string;
  /** Runtime + device type, e.g. "iOS 17.5 / iPhone 15". */
  readonly runtimeDeviceType: string;
  /** Managed host identity (hostname or stable host id). */
  readonly hostIdentity: string;
  /** AutoMobile package/version, e.g. "@kaeawc/auto-mobile@0.0.45". */
  readonly automobileVersion: string;
  /** Worker incarnation id — changes when the worker process is replaced. */
  readonly workerIncarnation: string;
  /** Process supervisor, e.g. "launchd". */
  readonly processSupervisor: string;
  /** Relevant process identifiers (daemon, runner, CoreSimulator service...). */
  readonly processIds: Readonly<Record<string, number>>;
  /** CoreSimulator data root / stable storage identity for this device. */
  readonly coreSimulatorDataRoot: string;
  /**
   * ISO timestamp of when the *current* boot session began. If this falls
   * inside the deploy window the running simulator did not survive even when the
   * UDID and data root did — that is boot recovery, not continuity. Optional in
   * the shape, but a *proven* same-device-continuity verdict requires it: when
   * absent, a reboot cannot be ruled out, so the result is `incomplete-evidence`.
   */
  readonly bootedSince?: string;
  /** Simulator lifecycle state. */
  readonly lifecycleState: SimulatorLifecycleState;
  /** Whether the simulator answered a responsiveness probe. */
  readonly responsive: boolean;
  /** AutoMobile/worker reporting status. */
  readonly reportingStatus: ReportingStatus;
  /** Whether an active lease, execution, or drain was present. */
  readonly activeWork: boolean;
}

/** The deployment window the evidence brackets. */
export interface DeploymentWindow {
  /** ISO timestamp the deploy started. */
  readonly startedAt: string;
  /** ISO timestamp the deploy completed. */
  readonly completedAt: string;
  /**
   * The operator declared this deploy an intentional, controlled replacement of
   * this device. A new UDID / data root is only acceptable continuity when this
   * is set — otherwise a changed identity is treated as orphaned/erased state.
   */
  readonly plannedReplacement?: boolean;
}

/** The distinguished continuity outcomes (issue #5104, AC5). */
export type ContinuityVerdict =
  | "same-device-continuity"
  | "controlled-replacement"
  | "boot-recovery"
  | "shutdown"
  | "reporting-delay"
  | "orphaned-or-erased-state"
  | "failed-probe"
  | "incomplete-evidence";

/** Whether the recommended post-deploy state is leaseable or held out. */
export type RecommendedState = "available" | "maintenance";

/** The outcome of classifying one before/after pair. */
export interface ContinuityResult {
  readonly verdict: ContinuityVerdict;
  /** True only when acceptable continuity is *proven*. */
  readonly proven: boolean;
  /** What the device should be marked as until fresh evidence exists. */
  readonly recommendedState: RecommendedState;
  /** Human-readable reasons behind the verdict. */
  readonly reasons: readonly string[];
}

/** A full evidence record for one managed simulator across a deploy. */
export interface ContinuityEvidence {
  readonly before: ContinuitySnapshot;
  readonly after: ContinuitySnapshot;
  readonly deploy: DeploymentWindow;
  /** Optional attached classification result. */
  readonly result?: ContinuityResult;
}

/**
 * A snapshot with sensitive fields replaced by one-way tokens. The token fields
 * are strings (not the raw UDID/host/PIDs) because that is what redaction
 * produces; keeping a distinct type avoids pretending a token is still a PID.
 */
export interface RedactedContinuitySnapshot extends Omit<
  ContinuitySnapshot,
  "udid" | "hostIdentity" | "workerIncarnation" | "coreSimulatorDataRoot" | "processIds"
> {
  readonly udid: string;
  readonly hostIdentity: string;
  readonly workerIncarnation: string;
  readonly coreSimulatorDataRoot: string;
  readonly processIds: Readonly<Record<string, string>>;
}

/** A redacted evidence record safe to retain or share. */
export interface RedactedContinuityEvidence {
  readonly before: RedactedContinuitySnapshot;
  readonly after: RedactedContinuitySnapshot;
  readonly deploy: DeploymentWindow;
  readonly result?: ContinuityResult;
}

/** Verdicts that count as acceptable, proven continuity. */
const PROVEN_VERDICTS: ReadonlySet<ContinuityVerdict> = new Set<ContinuityVerdict>([
  "same-device-continuity",
  "controlled-replacement",
]);

/** Identity/context fields that must be present for evidence to be usable. */
function hasRequiredIdentity(snapshot: ContinuitySnapshot): boolean {
  return (
    snapshot.udid.trim().length > 0 &&
    snapshot.runtimeDeviceType.trim().length > 0 &&
    snapshot.hostIdentity.trim().length > 0 &&
    snapshot.automobileVersion.trim().length > 0 &&
    snapshot.workerIncarnation.trim().length > 0 &&
    snapshot.processSupervisor.trim().length > 0 &&
    snapshot.coreSimulatorDataRoot.trim().length > 0 &&
    snapshot.reportingStatus !== "unknown"
  );
}

/** True when the device's current boot session began inside the deploy window. */
function rebootedDuringWindow(after: ContinuitySnapshot, deploy: DeploymentWindow): boolean {
  if (!after.bootedSince) {
    return false;
  }
  const bootedAt = Date.parse(after.bootedSince);
  const windowStart = Date.parse(deploy.startedAt);
  if (Number.isNaN(bootedAt) || Number.isNaN(windowStart)) {
    return false;
  }
  return bootedAt >= windowStart;
}

/** A verdict plus its reason, or null when a rule does not apply. */
interface RuleHit {
  readonly verdict: ContinuityVerdict;
  readonly reason: string;
}
type ContinuityRule = (
  before: ContinuitySnapshot,
  after: ContinuitySnapshot,
  deploy: DeploymentWindow,
) => RuleHit | null;

function hit(verdict: ContinuityVerdict, reason: string): RuleHit {
  return { verdict, reason };
}

/**
 * True when the after-snapshot identity changed vs before: UDID, CoreSimulator
 * data root, or host identity. The contract is scoped to one managed host, so a
 * host-identity change means the before/after evidence was captured on different
 * machines — that is not continuity of the same device.
 */
function identityChanged(before: ContinuitySnapshot, after: ContinuitySnapshot): boolean {
  return (
    after.udid !== before.udid ||
    after.coreSimulatorDataRoot !== before.coreSimulatorDataRoot ||
    after.hostIdentity !== before.hostIdentity
  );
}

/** True when the pre-deploy baseline was a healthy, booted, responsive device. */
function healthyBaseline(before: ContinuitySnapshot): boolean {
  return before.lifecycleState === "booted" && before.responsive;
}

/**
 * Ordered rules, from "cannot tell" to "clean continuity". The first rule that
 * fires wins, so an earlier, more serious finding takes precedence: incomplete
 * evidence and failed probes short-circuit before any continuity claim, and an
 * unexplained identity/data change is flagged as orphaned state (the AC3 guard)
 * rather than silently accepted. If no rule fires it is same-device continuity.
 */
const CONTINUITY_RULES: readonly ContinuityRule[] = [
  // 1. Incomplete evidence — required identity/context missing on either side.
  (before, after) =>
    hasRequiredIdentity(before) && hasRequiredIdentity(after)
      ? null
      : hit(
          "incomplete-evidence",
          "Required identity/context evidence is missing before or after the deploy.",
        ),
  // 2. Failed probe — the post-deploy device-state probe was indeterminate.
  (_before, after) =>
    after.lifecycleState === "unknown"
      ? hit("failed-probe", "Post-deploy simulator lifecycle state could not be determined.")
      : null,
  // 3. Explicit, controlled replacement — the only case where a changed identity
  //    or data root is acceptable, and only if the new device is actually up.
  //    A replacement must operate on an *idle* device: replacing one that had an
  //    active lease/execution/drain destroys that in-flight state, so it is
  //    flagged as orphaned/erased rather than certified as controlled.
  (before, after, deploy) => {
    if (!deploy.plannedReplacement) {
      return null;
    }
    if (before.activeWork) {
      return hit(
        "orphaned-or-erased-state",
        "Deploy was declared a controlled replacement but the simulator had active work (lease/execution/drain); replacement must operate on an idle device.",
      );
    }
    return after.lifecycleState === "booted" && after.responsive
      ? hit(
          "controlled-replacement",
          "Deploy was an explicit controlled replacement; the replacement simulator is booted and responsive.",
        )
      : hit(
          "failed-probe",
          "Deploy was declared a controlled replacement but the replacement simulator is not booted and responsive.",
        );
  },
  // 4. Orphaned/erased state — identity, CoreSimulator data, or host changed
  //    with no planned replacement to explain it. This is the AC3 guard.
  (before, after) =>
    identityChanged(before, after)
      ? hit(
          "orphaned-or-erased-state",
          "Simulator UDID, CoreSimulator data root, or host identity changed without a declared controlled replacement.",
        )
      : null,
  // From here the UDID and data root are unchanged.
  // 5. Shutdown — the same device is no longer booted.
  (_before, after) =>
    after.lifecycleState !== "booted"
      ? hit(
          "shutdown",
          `Simulator is ${after.lifecycleState} after the deploy and did not recover.`,
        )
      : null,
  // 6. Failed probe — booted but responsiveness could not be proven.
  (_before, after) =>
    after.responsive
      ? null
      : hit(
          "failed-probe",
          "Simulator is booted after the deploy but did not answer a responsiveness probe.",
        ),
  // 7. Boot recovery — same identity and data, but it rebooted mid-window, so
  //    the running simulator did not survive even though its data did.
  (_before, after, deploy) =>
    rebootedDuringWindow(after, deploy)
      ? hit(
          "boot-recovery",
          "Simulator rebooted during the deploy window; CoreSimulator data was preserved but the booted session did not survive.",
        )
      : null,
  // 8. Reporting delay/loss — device is continuous but the worker is not
  //    reporting for it. A restarted worker must not read as leaseable.
  (_before, after) =>
    after.reportingStatus === "reporting"
      ? null
      : hit(
          "reporting-delay",
          `Simulator is continuous but worker reporting is ${after.reportingStatus}.`,
        ),
  // 9. Provability guards for the clean-continuity claim. Same-device-continuity
  //    asserts "booted and responsive throughout", so the pre-deploy baseline
  //    must itself have been healthy — an unhealthy `before` cannot prove a
  //    healthy device was preserved.
  (before) =>
    healthyBaseline(before)
      ? null
      : hit(
          "incomplete-evidence",
          "Pre-deploy baseline was not a booted, responsive simulator; continuity of a healthy device cannot be proven.",
        ),
  // 10. Boot-session time is required to rule out a reboot during the window; a
  //     rollout that cannot prove the booted session survived is not proven.
  (_before, after) =>
    after.bootedSince
      ? null
      : hit(
          "incomplete-evidence",
          "Boot-session time (bootedSince) is required to prove the running simulator survived; without it a reboot cannot be ruled out.",
        ),
];

/**
 * Classify what happened to one managed simulator across a deploy window by
 * running the ordered {@link CONTINUITY_RULES}; the first rule that fires wins.
 */
export function classifyContinuity(
  before: ContinuitySnapshot,
  after: ContinuitySnapshot,
  deploy: DeploymentWindow,
): ContinuityResult {
  for (const rule of CONTINUITY_RULES) {
    const fired = rule(before, after, deploy);
    if (fired) {
      return result(fired.verdict, [fired.reason]);
    }
  }
  return result("same-device-continuity", [
    "Same UDID and CoreSimulator data root, booted and responsive throughout, worker reporting restored.",
  ]);
}

function result(verdict: ContinuityVerdict, reasons: readonly string[]): ContinuityResult {
  const proven = PROVEN_VERDICTS.has(verdict);
  return { verdict, proven, recommendedState: proven ? "available" : "maintenance", reasons };
}

/**
 * Process exit code for the deploy gate: 0 only when continuity is proven,
 * non-zero otherwise so a rollout that cannot prove continuity fails loudly.
 */
export function continuityExitCode(result: ContinuityResult): number {
  return result.proven ? 0 : 1;
}

/**
 * A fresh random salt for one redaction pass. A *fixed*, committed salt would
 * be worthless for enumerable inputs — with the salt public, PIDs and predictable
 * host names can be recovered by precomputing tokens offline. A per-artifact
 * random salt makes precomputation impossible while still preserving equality
 * *within* the artifact (same value → same token, because one salt is used for
 * the whole record). Cross-artifact correlation is intentionally not offered;
 * issue #5104 never requires correlating tokens across separate records.
 */
export function generateRedactionSalt(): string {
  return randomBytes(16).toString("hex");
}

/** One-way, within-artifact-correlation-preserving token for a sensitive value. */
function token(prefix: string, value: string, salt: string): string {
  const digest = createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 12);
  return `${prefix}:${digest}`;
}

function redactSnapshot(snapshot: ContinuitySnapshot, salt: string): RedactedContinuitySnapshot {
  const redactedPids: Record<string, string> = {};
  for (const [name, pid] of Object.entries(snapshot.processIds)) {
    // PIDs are not exposed; keep per-process correlation via a stable token.
    redactedPids[name] = token("pid", String(pid), salt);
  }
  return {
    ...snapshot,
    udid: token("sim", snapshot.udid, salt),
    hostIdentity: token("host", snapshot.hostIdentity, salt),
    workerIncarnation: token("worker", snapshot.workerIncarnation, salt),
    // The data root embeds the UDID and a home prefix; tokenize the whole path.
    coreSimulatorDataRoot: token("dataroot", snapshot.coreSimulatorDataRoot, salt),
    processIds: redactedPids,
  };
}

/**
 * Produce a redacted copy of an evidence record safe to retain with a
 * deployment record or share in a public issue (issue #5104, AC7). Host names,
 * UDIDs, PIDs, and home-dir paths are replaced with one-way tokens that preserve
 * equality *within this record* — so a reader can still tell "same device before
 * and after" or "the worker was replaced" — without exposing the raw values. The
 * non-sensitive fields (runtime/device type, version, lifecycle, reporting,
 * timestamps) are kept verbatim so the evidence stays readable.
 *
 * @param salt - Injectable redaction salt. Defaults to a fresh random salt per
 *   call so tokens cannot be precomputed from a known salt; pass a fixed salt in
 *   tests to assert token stability.
 */
export function redactContinuityEvidence(
  evidence: ContinuityEvidence,
  salt: string = generateRedactionSalt(),
): RedactedContinuityEvidence {
  // reasons only interpolate lifecycle/reporting enums today; redactHomeDir is a
  // cheap guard against a future reason that embeds a path, not a load-bearing
  // control.
  const redactedResult = evidence.result
    ? { ...evidence.result, reasons: evidence.result.reasons.map((r) => redactHomeDir(r)) }
    : undefined;
  return {
    before: redactSnapshot(evidence.before, salt),
    after: redactSnapshot(evidence.after, salt),
    deploy: evidence.deploy,
    ...(redactedResult ? { result: redactedResult } : {}),
  };
}
