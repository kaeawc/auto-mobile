import type { DeviceLabelMap } from "./sessionManager";

/** What the registry needs from its host: whether a session is currently published. */
export interface PlanLabelRegistryHost {
  hasSession(sessionId: string): boolean;
}

export interface EndedLabelBase {
  baseSessionId: string;
  releaseReason: string;
}

/**
 * The bookkeeping behind plan-run derived `${base}:${label}` sessions (#11091, #11572, #11640):
 * which labels belong to which base, which a plan allocation may mint right now, which a plan run
 * minted and still runs, and which ended with their base. Pure state; the terminal fence, the
 * terminal answers and the slot probe stay with the session manager.
 */
export class PlanLabelRegistry {
  // Base session → its derived `${base}:${label}` sessions (#11091), outside the base's cache so
  // it survives the base's removal. Consumed by takeDerivedLabelSessions.
  private readonly derivedLabelSessionsByBase = new Map<string, Set<string>>();
  // Retain the base's terminal end while the cascade owns a still-published label (#11640).
  private readonly endedLabelBases = new Map<string, EndedLabelBase>();
  /** Derived label sessions a plan run's allocation may mint right now, counted per open run (#11572). */
  private readonly planLabelMints = new Map<string, number>();
  /** Derived label sessions a plan run in this daemon minted, until their base is released (#11572). */
  private readonly runningPlanLabelSessions = new Set<string>();

  constructor(private readonly host: PlanLabelRegistryHost) {}

  /** Index the derived sessions named by `labels` under `baseSessionId`. */
  indexDerivedLabels(baseSessionId: string, labels: DeviceLabelMap): void {
    const derived = Object.values(labels).filter((labelSession) => labelSession !== baseSessionId);
    if (derived.length > 0) {
      const indexed = this.derivedLabelSessionsByBase.get(baseSessionId) ?? [];
      this.derivedLabelSessionsByBase.set(baseSessionId, new Set([...indexed, ...derived]));
    }
  }

  /** Open a plan allocation's mint window; the returned function closes it (idempotent). */
  openPlanLabelMints(baseSessionId: string, labels: DeviceLabelMap): () => void {
    const derived = [...new Set(Object.values(labels))].filter(
      (labelSession) => labelSession !== baseSessionId,
    );
    for (const labelSession of derived) {
      this.planLabelMints.set(labelSession, (this.planLabelMints.get(labelSession) ?? 0) + 1);
    }
    let open = true;
    return () => {
      if (!open) {
        return;
      }
      open = false;
      for (const labelSession of derived) {
        const remaining = (this.planLabelMints.get(labelSession) ?? 1) - 1;
        if (remaining > 0) {
          this.planLabelMints.set(labelSession, remaining);
        } else {
          this.planLabelMints.delete(labelSession);
        }
      }
    };
  }

  /** Whether a plan allocation may mint `sessionId` right now. */
  isMinting(sessionId: string): boolean {
    return this.planLabelMints.has(sessionId);
  }

  /** Whether `sessionId` is mintable now and not live: the previous run's fence may be lifted. */
  isMintableAndNotLive(sessionId: string): boolean {
    return this.planLabelMints.has(sessionId) && !this.host.hasSession(sessionId);
  }

  /** The persisted creator of a session being created: a plan run's label mint marks its row. */
  creatorSource(
    sessionId: string,
    persistenceSource: string | undefined,
    planLabelSource: string,
  ): string | undefined {
    return this.planLabelMints.has(sessionId) ? planLabelSource : persistenceSource;
  }

  /** The base `sessionId` was indexed under as a derived label, or undefined. */
  getBaseSessionOfDerivedLabel(sessionId: string): string | undefined {
    for (const [base, derived] of this.derivedLabelSessionsByBase) {
      if (derived.has(sessionId)) {
        return base;
      }
    }
    return undefined;
  }

  /** The longest prefix of `sessionId` (split at ":") that `isLive` accepts. */
  liveBaseOfDerivedId(
    sessionId: string,
    isLive: (candidate: string) => boolean,
  ): string | undefined {
    for (
      let separatorIndex = sessionId.lastIndexOf(":");
      separatorIndex > 0;
      separatorIndex = sessionId.lastIndexOf(":", separatorIndex - 1)
    ) {
      const candidate = sessionId.slice(0, separatorIndex);
      if (isLive(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /** Mark a label session a plan run in this daemon published. */
  markRunning(sessionId: string): void {
    this.runningPlanLabelSessions.add(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.runningPlanLabelSessions.has(sessionId);
  }

  /**
   * Remove and return every derived session indexed for `baseSessionId`. A terminal release
   * retains the base's end for each still-published label, and the base's plan run is over.
   */
  takeDerivedLabelSessions(
    baseSessionId: string,
    releaseReason: string | undefined,
    isTerminalReleaseReason: (reason: string) => boolean,
  ): string[] {
    const derived = this.derivedLabelSessionsByBase.get(baseSessionId);
    if (releaseReason !== undefined && isTerminalReleaseReason(releaseReason)) {
      for (const labelSessionId of derived ?? []) {
        if (this.host.hasSession(labelSessionId)) {
          this.endedLabelBases.set(labelSessionId, { baseSessionId, releaseReason });
        }
      }
    }
    this.derivedLabelSessionsByBase.delete(baseSessionId);
    // The base is being released: its plan run, and with it every label session's, is over.
    derived?.forEach((labelSession) => this.runningPlanLabelSessions.delete(labelSession));
    return derived ? [...derived] : [];
  }

  /** The base end retained for a still-published label, if any. */
  retainedEndedBase(labelSessionId: string): EndedLabelBase | undefined {
    return this.endedLabelBases.get(labelSessionId);
  }

  clearEndedBase(sessionId: string): void {
    this.endedLabelBases.delete(sessionId);
  }
}
