import { DaemonBoundSessionExpiredError } from "./daemonErrors";
import type { NotFoundAnswerOutcome } from "./notFoundDecision";
import type { StallHandoverRecord } from "./ProxySessionState";
import type { SessionReleaseSnapshot } from "../sessionManager";

/** A held session's terminal loss waiting for one platform-only control answer (#12090). */
export interface PendingHeldSessionLoss {
  platform: "android" | "ios";
  reason: string;
  release?: SessionReleaseSnapshot;
  proxyJudged?: true;
}

/**
 * Proxy state and operations the held-session loss records read:
 * - boundSessionUuid and terminalBoundSessionUuid read the live binding scalars.
 * - isOtherHeldSession, otherHeldSessionUuids and stallHandover read the held-session registries.
 * - isSessionlessControlDeviceTool and sessionUuidFromArgs keep routing policy in the proxy.
 * - reportPendingSessionLoss and noteReleaseSurfacedBy consume the stall-loss and surfaced-release records.
 */
export interface HeldSessionLossesPort {
  boundSessionUuid(): string | undefined;
  terminalBoundSessionUuid(): string | undefined;
  isOtherHeldSession(sessionUuid: string): boolean;
  otherHeldSessionUuids(): Iterable<string>;
  stallHandover(sessionUuid: string): StallHandoverRecord | undefined;
  isSessionlessControlDeviceTool(name: string, args: Record<string, unknown>): boolean;
  sessionUuidFromArgs(args: Record<string, unknown>): string | undefined;
  reportPendingSessionLoss(args: Record<string, unknown>, terminalRouted?: boolean): void;
  noteReleaseSurfacedBy(answer: unknown): void;
}

/**
 * Held terminal losses awaiting one platform-only control answer, in loss order (#12090). A loss
 * is reported at most once: reporting consumes it, and selecting the session or a live session of
 * the same platform clears it.
 */
export class HeldSessionLosses {
  /** Keyed by session uuid; shared by reference with the session binding. */
  readonly pending = new Map<string, PendingHeldSessionLoss>();

  constructor(
    private readonly sessionPlatforms: Map<string, "android" | "ios">,
    private readonly port: HeldSessionLossesPort,
  ) {}

  recordTerminalLoss(
    sessionUuid: string,
    reason = "released",
    release?: SessionReleaseSnapshot,
    proxyJudged?: true,
  ): void {
    const pending = this.pending.get(sessionUuid);
    if (pending) {
      pending.reason = reason === "released" ? pending.reason : reason;
      pending.release = release ?? pending.release;
      pending.proxyJudged = proxyJudged;
      return;
    }
    const platform = this.sessionPlatforms.get(sessionUuid);
    const handedOver = this.port.stallHandover(sessionUuid);
    if (
      platform === undefined ||
      sessionUuid === this.port.boundSessionUuid() ||
      sessionUuid === this.port.terminalBoundSessionUuid() ||
      (!this.port.isOtherHeldSession(sessionUuid) && (!handedOver || handedOver.restore.bound))
    ) {
      return;
    }
    this.pending.set(sessionUuid, { platform, reason, release, proxyJudged });
  }

  recordNotFoundLoss(sessionUuid: string, outcome: NotFoundAnswerOutcome): void {
    if (outcome.kind === "ended") {
      this.recordTerminalLoss(sessionUuid, outcome.reason);
    }
  }

  clearForSelection(sessionUuid: string, callPlatform?: unknown): void {
    this.pending.delete(sessionUuid);
    const platform = this.sessionPlatforms.get(sessionUuid) ?? callPlatform;
    if (platform === "android" || platform === "ios") {
      this.clearPlatformLosses(platform);
    }
  }

  clearPlatformLosses(platform: "android" | "ios" | undefined): void {
    if (platform === undefined) {
      return;
    }
    for (const [sessionUuid, loss] of this.pending) {
      if (loss.platform === platform) {
        this.pending.delete(sessionUuid);
      }
    }
  }

  /** Ambiguity and the default fence win; reads leave these one-shot reports untouched. */
  reportPlatformLoss(name: string, args: Record<string, unknown>): void {
    const platform = args.platform;
    if (
      this.port.terminalBoundSessionUuid() !== undefined ||
      !this.port.isSessionlessControlDeviceTool(name, args) ||
      (platform !== "android" && platform !== "ios") ||
      typeof args.deviceId === "string" ||
      this.port.sessionUuidFromArgs(args) !== undefined ||
      args.device
    ) {
      return;
    }
    const live = [this.port.boundSessionUuid(), ...this.port.otherHeldSessionUuids()];
    if (live.some((id) => id !== undefined && this.sessionPlatforms.get(id) === platform)) {
      this.clearPlatformLosses(platform);
      return;
    }
    for (const [sessionUuid, loss] of this.pending) {
      if (loss.platform === platform) {
        // A terminal stall already has its typed answer; reporting it consumes both records.
        this.port.reportPendingSessionLoss({ sessionUuid });
        const answer = new DaemonBoundSessionExpiredError(sessionUuid, loss.reason, loss.release);
        this.port.noteReleaseSurfacedBy(answer);
        throw answer;
      }
    }
  }
}
