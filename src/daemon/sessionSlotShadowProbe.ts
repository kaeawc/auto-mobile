import { errorMessage } from "../utils/describeUnknownError";
import {
  deriveLatestSessionIdentity,
  deriveSlot,
  SlotTransitionGuard,
  isSlotKnown,
  isSlotTagBeingRecreated,
  type LegacyLifecycleView,
} from "./sessionSlots";

export type SlotShadowProbeMode = "throw" | "log" | "off";

export interface LegacySlotPredicates<S> {
  isCurrentSession(session: S): boolean;
  isAdmittedForAutomation(session: S): boolean;
  isLatestSessionIdentity(session: S): boolean;
  isSessionBeingRecreated(uuid: string): boolean;
  isKnownSessionId(uuid: string): boolean;
}

export interface SlotShadowLogger {
  debug(message: string): void;
  warn(message: string): void;
}

/** Diagnostic only: never consult this probe to decide a lifecycle operation. */
export class SessionSlotShadowProbe<S> {
  private currentMode: SlotShadowProbeMode = "log";

  get mode(): SlotShadowProbeMode {
    return this.currentMode;
  }

  set mode(mode: SlotShadowProbeMode) {
    if (mode === "off") {
      this.transitionGuard.reset();
    }
    this.currentMode = mode;
  }

  readonly transitionGuard: SlotTransitionGuard;

  constructor(
    private readonly view: () => LegacyLifecycleView<S>,
    private legacy: LegacySlotPredicates<S> | undefined,
    private readonly logger: SlotShadowLogger,
    private readonly notifySettled?: (uuid: string) => void,
  ) {
    this.transitionGuard = new SlotTransitionGuard(logger);
  }

  /** Tests supply the frozen pre-migration oracle; production only checks transitions. */
  setReferencePredicates(reference: LegacySlotPredicates<S>): void {
    this.legacy = reference;
  }

  check(uuid: string, event: string, identities: readonly S[] = []): void {
    this.notifySettled?.(uuid);
    if (this.mode === "off") {
      return;
    }
    if (this.mode === "throw") {
      this.observe(uuid, event);
      this.compare(uuid, event, identities);
      return;
    }
    try {
      this.observe(uuid, event);
      this.compare(uuid, event, identities);
    } catch (error) {
      // A diagnostic must never prevent the legacy lifecycle operation from completing.
      this.logger.warn(
        `[SessionSlotShadowProbe] uuid=${uuid} event=${event}: ${errorMessage(error)}`,
      );
    }
  }

  private observe(uuid: string, event: string): void {
    if (LIFECYCLE_HOOKS.has(event)) {
      this.transitionGuard.check(
        uuid,
        event,
        deriveSlot(this.view(), uuid),
        this.mode === "throw" ? "throw" : "log",
      );
    }
  }

  private readIdentities(view: LegacyLifecycleView<S>, uuid: string, identities: readonly S[]) {
    const latest = deriveLatestSessionIdentity(view, uuid);
    const candidates = new Set([
      view.sessions.get(uuid),
      view.releaseOps.get(uuid)?.session,
      view.latestFinalizedIdentities.get(uuid)?.deref(),
      ...identities,
    ]);
    return [...candidates]
      .filter((s) => s !== undefined)
      .map((s) => ({
        derived: latest === s,
        legacy: this.legacy!.isLatestSessionIdentity(s),
      }));
  }

  private compare(uuid: string, event: string, identities: readonly S[]): void {
    if (!this.legacy) {
      return;
    }
    const view = this.view();
    const slot = deriveSlot(view, uuid);
    const session = view.sessions.get(uuid);
    const current =
      session !== undefined &&
      (slot.tag === "live" ||
        slot.tag === "rebinding" ||
        (slot.tag === "releasing" && slot.fence === "none"));
    const derived = {
      current,
      admitted: current && !view.isReleasing(session!),
      recreated: isSlotTagBeingRecreated(slot.tag),
      known: isSlotKnown(slot),
    };
    const legacy = {
      current: session !== undefined && this.legacy.isCurrentSession(session),
      admitted: session !== undefined && this.legacy.isAdmittedForAutomation(session),
      recreated: this.legacy.isSessionBeingRecreated(uuid),
      known: this.legacy.isKnownSessionId(uuid),
    };
    const identityReads = this.readIdentities(view, uuid, identities);
    if (
      JSON.stringify(derived) === JSON.stringify(legacy) &&
      identityReads.every((read) => read.derived === read.legacy)
    ) {
      return;
    }
    const message =
      `[SessionSlotShadowProbe] uuid=${uuid} event=${event} slot=${JSON.stringify(slot)} ` +
      `derived=${JSON.stringify(derived)} legacy=${JSON.stringify(legacy)} identities=${JSON.stringify(identityReads)}`;
    if (this.mode === "throw") {
      throw new Error(message);
    }
    this.logger.debug(message);
  }
}

const LIFECYCLE_HOOKS = new Set([
  "creation-start",
  "creation-end",
  "assignment-start",
  "assignment-end",
  "published",
  "rebind-start",
  "rebind-end",
  "release-start",
  "release-end",
  "unpublished",
  "plan-label-fence-lifted",
  "recovered-terminal-intent-deleted",
]);
