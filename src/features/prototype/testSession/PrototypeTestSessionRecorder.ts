import type { PrototypeEvent } from "../../observe/android/ctrlProxyProtocol";
import type { PrototypeScope } from "../PrototypeStatusStore";
import type {
  PrototypeTestSessionStore,
  TestSession,
  EndedReason,
} from "../../../db/prototypeTestSessionRepository";
import type { Timer } from "../../../utils/SystemTimer";
import type { IdGenerator } from "../../../utils/IdGenerator";
import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import { recordableStep } from "./prototypeTestSessionEvent";
import {
  buildPrototypeTestSessionReport,
  renderPrototypeTestSessionMarkdown,
} from "./prototypeTestSessionReport";

export interface PrototypeTestSessionRecorderDependencies {
  store: PrototypeTestSessionStore;
  timer: Pick<Timer, "now">;
  ids: IdGenerator;
  secureKeys(scope: PrototypeScope, id: string): ReadonlySet<string>;
  startScreen(scope: PrototypeScope, id: string): string;
  deadTapsEnabled(scope: PrototypeScope, id: string): boolean;
}
export class PrototypeTestSessionRecorder {
  private readonly recording = new Map<
    string,
    { scope: PrototypeScope; id: string; testSessionId: string }
  >();
  private key(scope: PrototypeScope, id: string): string {
    return JSON.stringify([scope.sessionUuid ?? null, scope.deviceId, id]);
  }
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly deps: PrototypeTestSessionRecorderDependencies) {}
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.then(
      () => {},
      (error) => {
        logger.warn("Prototype test session persistence failed", error);
      },
    );
    return result;
  }
  flush(): Promise<void> {
    return this.chain;
  }
  begin(scope: PrototypeScope, id: string, options: { goal?: string; cohort?: string } = {}) {
    const started = this.deps.timer.now();
    const screen = this.deps.startScreen(scope, id);
    const deadTaps = this.deps.deadTapsEnabled(scope, id) ? "enabled" : "off";
    const testSessionId = this.deps.ids.next();
    const key = this.key(scope, id);
    const owned = [...this.recording.values()].some(
      (entry) => entry.scope.deviceId === scope.deviceId && entry.id === id,
    );
    // Reserve before awaiting SQLite so events arriving during begin queue behind its insert.
    if (!owned) {
      this.recording.set(key, { scope: { ...scope }, id, testSessionId });
    }
    return this.enqueue(async () => {
      const existing = await this.deps.store.findActive(scope, id);
      if (existing && owned) {
        throw new ActionableError(
          "A test session is already active for this device and prototype. End it with testSessionEnd before beginning another.",
        );
      }
      if (existing) {
        // Nothing in this daemon records it: a restart left the row active and no call could end it.
        await this.deps.store.endSession(
          existing.test_session_id,
          Math.max(existing.started_at_ms, started),
          "released",
        );
      }
      const session: TestSession = {
        test_session_id: testSessionId,
        prototype_id: id,
        device_id: scope.deviceId,
        session_uuid: scope.sessionUuid ?? null,
        cohort: options.cohort ?? null,
        goal: options.goal ?? null,
        start_screen: screen,
        status: "active",
        started_at_ms: started,
        ended_at_ms: null,
        ended_reason: null,
        dropped_count: 0,
      };
      await this.deps.store.insertSession(session);
      this.recording.set(this.key(scope, id), {
        scope: { ...scope },
        id,
        testSessionId: session.test_session_id,
      });
      return {
        session,
        eventCount: 0,
        deadTaps: deadTaps as "enabled" | "off",
        ...(deadTaps === "off"
          ? {
              warning:
                "Add window.deadTaps: true via show to record dead taps (requires prototype_dead_tap_v1).",
            }
          : {}),
      };
    }).catch((error) => {
      if (this.recording.get(key)?.testSessionId === testSessionId) {
        this.recording.delete(key);
      }
      throw toActionableError(error, "Failed to begin prototype test session");
    });
  }
  /** Sanitizes synchronously: queued work never captures text-bearing wire events. */
  recordEvent(scope: PrototypeScope, event: PrototypeEvent): void {
    const recording = this.recording.get(this.key(scope, event.id));
    if (!recording) {
      return;
    }
    // Host receive time, not the device's event timestamp: a physical device's clock can be skewed
    // from the host's, which would corrupt every duration measured against the session's start.
    const at = this.deps.timer.now();
    const recorded = recordableStep(event, this.deps.secureKeys(scope, event.id));
    const step = recorded && { ...recorded, at_ms: at };
    const dismissed = event.kind === "dismissed";
    // The queue owns failures; they must never reject into the device event callback.
    void this.enqueue(async () => {
      const session = await this.deps.store.findById(recording.testSessionId);
      if (session?.status !== "active") {
        return;
      }
      if (step) {
        try {
          await this.deps.store.appendEvents(session.test_session_id, [step]);
        } catch (error) {
          logger.warn("Prototype test event append failed", error);
        }
      }
      if (dismissed) {
        await this.finish(session, at, "dismissed");
        await this.deps.store.pruneEnded();
      }
    }).catch((error) => {
      logger.warn("Prototype test event was not persisted", error);
    });
  }
  private async active(scope: PrototypeScope, id: string): Promise<TestSession | undefined> {
    const session = await this.deps.store.findActive(scope, id);
    return session?.session_uuid === (scope.sessionUuid ?? null) ? session : undefined;
  }
  private async finish(session: TestSession, at: number, reason: EndedReason): Promise<void> {
    await this.deps.store.endSession(
      session.test_session_id,
      Math.max(session.started_at_ms, at),
      reason,
    );
    this.recording.delete(
      this.key(
        { deviceId: session.device_id, sessionUuid: session.session_uuid ?? undefined },
        session.prototype_id,
      ),
    );
  }
  endForDismiss(scope: PrototypeScope, id: string, reason: "dismissed" | "released"): void {
    const recording = this.recording.get(this.key(scope, id));
    if (!recording) {
      return;
    }
    const at = this.deps.timer.now();
    void this.enqueue(async () => {
      const session = await this.deps.store.findById(recording.testSessionId);
      if (session?.status === "active") {
        await this.finish(session, at, reason);
        await this.deps.store.pruneEnded();
      }
    }).catch((error) => {
      logger.warn("Prototype test session cleanup failed", error);
    });
  }
  endSessionRecordings(sessionUuid: string): void {
    for (const { scope, id } of this.recording.values()) {
      if (scope.sessionUuid === sessionUuid) {
        this.endForDismiss(scope, id, "released");
      }
    }
  }
  endDeviceRecordings(deviceId: string): void {
    for (const { scope, id } of this.recording.values()) {
      if (scope.deviceId === deviceId) {
        this.endForDismiss(scope, id, "released");
      }
    }
  }
  end(scope: PrototypeScope, id: string) {
    const at = this.deps.timer.now();
    return this.enqueue(async () => {
      const session = await this.active(scope, id);
      if (!session) {
        throw new ActionableError(
          "No active test session for this scope and prototype. Use testSessionBegin first, or testSessionReport for a stored session.",
        );
      }
      await this.finish(session, at, "end");
      const result = await this.result(
        {
          ...session,
          status: "ended",
          ended_at_ms: Math.max(session.started_at_ms, at),
          ended_reason: "end",
        },
        scope,
      );
      await this.deps.store.pruneEnded();
      return result;
    });
  }
  report(scope: PrototypeScope, options: { id?: string; testSessionId?: string }) {
    return this.enqueue(async () => {
      const session = options.testSessionId
        ? await this.deps.store.findById(options.testSessionId)
        : await this.deps.store.findLatest(scope, options.id!);
      if (!session || (options.id !== undefined && options.id !== session.prototype_id)) {
        throw new ActionableError(
          "No stored test session for this id. Check testSessionId or begin a test session for this prototype.",
        );
      }
      return this.result(session, {
        deviceId: session.device_id,
        sessionUuid: session.session_uuid ?? undefined,
      });
    });
  }
  private async result(session: TestSession, scope: PrototypeScope) {
    const events = await this.deps.store.listEvents(session.test_session_id);
    const report = buildPrototypeTestSessionReport(session, events, this.deps.timer.now());
    return {
      session,
      eventCount: events.length,
      deadTaps: this.deps.deadTapsEnabled(scope, session.prototype_id)
        ? ("enabled" as const)
        : ("off" as const),
      report,
      markdown: renderPrototypeTestSessionMarkdown(report),
    };
  }
}
