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

/** A verdict plus its reason. */
interface RuleHit {
  readonly verdict: ContinuityVerdict;
  readonly reason: string;
}

function hit(verdict: ContinuityVerdict, reason: string): RuleHit {
  return { verdict, reason };
}

// Strict ISO-8601 date-time with a timezone: `2026-08-07T10:00:00(.000)?(Z|±hh:mm)`.
// Permissive Date.parse alone accepts junk like "0"/"1" as valid dates, which
// would let malformed evidence read as proven — so the shape is checked too.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** True when the value is a strict ISO-8601 timestamp with a real calendar value. */
function isValidTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
}

/** True when all identity/context evidence and the deploy window are present and well-formed. */
function evidenceComplete(
  before: ContinuitySnapshot,
  after: ContinuitySnapshot,
  deploy: DeploymentWindow,
): boolean {
  if (!hasRequiredIdentity(before) || !hasRequiredIdentity(after)) {
    return false;
  }
  // A well-formed, non-inverted deploy window is required to reason about it.
  return (
    isValidTimestamp(deploy.startedAt) &&
    isValidTimestamp(deploy.completedAt) &&
    Date.parse(deploy.startedAt) <= Date.parse(deploy.completedAt)
  );
}

/**
 * A boot-recovery verdict when the current boot session began at or after the
 * deploy started (so the pre-deploy booted session did not survive), or null when
 * it began before the deploy (the session survived). A boot at or after the start
 * is not proven regardless of whether it lands inside or after the window — a
 * post-window reboot before capture still means the session did not survive — but
 * the reason distinguishes the two. Reached only after the isValidTimestamp gates.
 */
function bootRecovery(after: ContinuitySnapshot, deploy: DeploymentWindow): RuleHit | null {
  const bootedAt = Date.parse(after.bootedSince as string);
  if (bootedAt < Date.parse(deploy.startedAt)) {
    return null;
  }
  const duringWindow = bootedAt <= Date.parse(deploy.completedAt);
  return hit(
    "boot-recovery",
    duringWindow
      ? "Simulator rebooted during the deploy window; CoreSimulator data was preserved but the booted session did not survive."
      : "Simulator's boot session began after the deploy completed but before capture; the pre-deploy booted session did not survive.",
  );
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

/**
 * Post-deploy proof shared by both the continuity and the controlled-replacement
 * paths: whatever device is present after the deploy must be booted, responsive,
 * reporting, and carry a valid boot-session time. Returns the first shortfall as
 * a not-proven verdict, or null when the after-state is fully proven.
 */
function postStateShortfall(after: ContinuitySnapshot): RuleHit | null {
  if (after.lifecycleState === "unknown") {
    return hit("failed-probe", "Post-deploy simulator lifecycle state could not be determined.");
  }
  if (after.lifecycleState !== "booted") {
    return hit(
      "shutdown",
      `Simulator is ${after.lifecycleState} after the deploy and did not recover.`,
    );
  }
  if (!after.responsive) {
    return hit(
      "failed-probe",
      "Simulator is booted after the deploy but did not answer a responsiveness probe.",
    );
  }
  if (!isValidTimestamp(after.bootedSince)) {
    return hit(
      "incomplete-evidence",
      "Boot-session time (bootedSince) is missing or invalid; the booted session cannot be proven.",
    );
  }
  if (after.reportingStatus !== "reporting") {
    return hit("reporting-delay", `Worker reporting is ${after.reportingStatus} after the deploy.`);
  }
  return null;
}

/** Classify an explicit, controlled replacement: idle old device, same host, replacement fully up. */
function classifyReplacement(before: ContinuitySnapshot, after: ContinuitySnapshot): RuleHit {
  if (before.activeWork) {
    return hit(
      "orphaned-or-erased-state",
      "Declared controlled replacement but the simulator had active work (lease/execution/drain); replacement must operate on an idle device.",
    );
  }
  if (before.hostIdentity !== after.hostIdentity) {
    return hit(
      "orphaned-or-erased-state",
      "Declared controlled replacement but the before/after evidence is from different hosts; a replacement must stay on the same managed host.",
    );
  }
  const shortfall = postStateShortfall(after);
  if (shortfall) {
    return shortfall;
  }
  return hit(
    "controlled-replacement",
    "Explicit controlled replacement; the replacement simulator is booted, responsive, and reporting on the same host.",
  );
}

/** Classify a non-replacement deploy: the same device must have survived intact. */
function classifySameDevice(
  before: ContinuitySnapshot,
  after: ContinuitySnapshot,
  deploy: DeploymentWindow,
): RuleHit {
  if (identityChanged(before, after)) {
    return hit(
      "orphaned-or-erased-state",
      "Simulator UDID, CoreSimulator data root, or host identity changed without a declared controlled replacement.",
    );
  }
  const shortfall = postStateShortfall(after);
  if (shortfall) {
    return shortfall;
  }
  // After-state is fully proven; now the survival-specific checks.
  const recovery = bootRecovery(after, deploy);
  if (recovery) {
    return recovery;
  }
  if (before.lifecycleState !== "booted" || !before.responsive) {
    return hit(
      "incomplete-evidence",
      "Pre-deploy baseline was not a booted, responsive simulator; continuity of a healthy device cannot be proven.",
    );
  }
  return hit(
    "same-device-continuity",
    "Same UDID, data root, and host; booted and responsive throughout, worker reporting restored.",
  );
}

/**
 * Classify what happened to one managed simulator across a deploy window.
 *
 * Both a controlled replacement and a same-device survival must clear the same
 * post-deploy proof ({@link postStateShortfall} — booted, responsive, reporting,
 * valid boot time); they differ only in what a legitimate identity change means
 * and whether the running session had to survive. Incomplete or malformed
 * evidence short-circuits before any continuity claim.
 */
export function classifyContinuity(
  before: ContinuitySnapshot,
  after: ContinuitySnapshot,
  deploy: DeploymentWindow,
): ContinuityResult {
  if (!evidenceComplete(before, after, deploy)) {
    return result("incomplete-evidence", [
      "Required identity/context evidence is missing, or the deploy window timestamps are absent, malformed, or inverted.",
    ]);
  }
  const fired = deploy.plannedReplacement
    ? classifyReplacement(before, after)
    : classifySameDevice(before, after, deploy);
  return result(fired.verdict, [fired.reason]);
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
