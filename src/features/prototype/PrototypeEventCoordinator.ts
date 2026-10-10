import type { PrototypeEvent } from "../observe/android/ctrlProxyProtocol";
import type { PrototypeScope, PrototypeStatusStore } from "./PrototypeStatusStore";
import {
  PrototypeEventBuffer,
  type PrototypeEventCounts,
  type PrototypeEventFilter,
} from "./PrototypeEventBuffer";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models/ActionableError";

import {
  DEFAULT_PROTOTYPE_EVENT_TIMEOUT_MS,
  MAX_PROTOTYPE_EVENT_TIMEOUT_MS,
} from "./prototypeEventTimeout";

export { DEFAULT_PROTOTYPE_EVENT_TIMEOUT_MS, MAX_PROTOTYPE_EVENT_TIMEOUT_MS };
export interface PrototypeEventSource {
  onPrototypeEvent(listener: (event: PrototypeEvent) => void): () => void;
}
export interface PrototypeEventTelemetry {
  recordPrototypeEvent(scope: PrototypeScope, event: PrototypeEvent): void;
}
export interface PrototypeAwaitResult extends PrototypeEventCounts {
  event?: Omit<PrototypeEvent, "type">;
  timedOut?: true;
  reason?: "dismissed";
}
interface Entry {
  scope: PrototypeScope;
  id: string;
  buffer: PrototypeEventBuffer;
  shown: boolean;
  terminal: boolean;
  waiters: Set<() => void>;
}
const scopeKey = (scope: PrototypeScope, id: string) =>
  JSON.stringify([scope.sessionUuid ?? null, scope.deviceId, id]);

/** One subscription per device client; only the current device/id owner receives pushes. */
export class PrototypeEventCoordinator {
  private readonly entries = new Map<string, Entry>();
  private readonly sources = new Map<
    string,
    { client: PrototypeEventSource; unsubscribe: () => void }
  >();

  constructor(
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">,
    private readonly store: PrototypeStatusStore,
    private readonly telemetry?: PrototypeEventTelemetry,
  ) {}

  /** Subscribe before show dispatch so a push during the request cannot be lost. */
  show(scope: PrototypeScope, id: string, client: PrototypeEventSource): void {
    for (const entry of this.entries.values()) {
      if (
        entry.scope.deviceId === scope.deviceId &&
        entry.id === id &&
        scopeKey(entry.scope, id) !== scopeKey(scope, id)
      ) {
        this.remove(entry);
      }
    }
    const entry = this.watch(scope, id, client);
    // A show starts a fresh sequence epoch: the device's sequence ledger is in memory and a
    // CtrlProxy restart restarts it at 1, so the previous showing's high-water mark must not
    // reject the new showing's events. Pushes carry only id/sequence/timestamp (no show
    // generation), so a late event from the PREVIOUS showing cannot be told apart from the
    // new showing's events and is accepted if it arrives after this reset.
    this.store.startShow(scope);
    entry.buffer.startEpoch();
    entry.shown = true;
    entry.terminal = false;
    this.subscribe(scope.deviceId, client);
  }

  /**
   * Takes over a prototype the device reported (`inspect`) that this host did not show, for example
   * after a session release. `replayed` are the events the device had buffered while no host was
   * connected, in wire order; `lastSequence` is the device ledger's high-water mark, so sequences
   * continue from it with no rewind.
   */
  adopt(
    scope: PrototypeScope,
    id: string,
    client: PrototypeEventSource,
    replayed: readonly PrototypeEvent[],
    lastSequence: number,
  ): void {
    const known = this.entries.get(scopeKey(scope, id));
    // A replayed terminal event may already have ended the entry (shown false, terminal true)
    // before this runs; its unconsumed events are still this host's to deliver.
    const holdsEvents = known?.terminal === true && known.buffer.status().pendingCount > 0;
    if ((known?.shown && !known.terminal) || holdsEvents) {
      // Re-inspecting a prototype this host already tracks must not start a new epoch: that would
      // clear the unconsumed events, and advancing the ledger below would make them unrecoverable.
      this.watch(scope, id, client);
    } else {
      this.show(scope, id, client);
    }
    for (const event of replayed) {
      this.receive(scope.deviceId, event);
    }
    this.entries.get(scopeKey(scope, id))?.buffer.advanceTo(lastSequence);
  }

  isDismissed(scope: PrototypeScope, id: string): boolean {
    return this.entries.get(scopeKey(scope, id))?.terminal ?? false;
  }

  counts(scope: PrototypeScope, id: string): PrototypeEventCounts | undefined {
    return this.entries.get(scopeKey(scope, id))?.buffer.status();
  }

  async awaitEvent(
    scope: PrototypeScope,
    id: string,
    client: PrototypeEventSource,
    options: PrototypeEventFilter & { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PrototypeAwaitResult> {
    options.signal?.throwIfAborted();
    const entry = this.watch(scope, id, client);
    const immediate = this.take(entry, options);
    if (immediate) {
      this.dropConsumedTerminal(entry);
      this.pruneSources();
      return immediate;
    }
    return this.wait(entry, options);
  }

  /**
   * A successful show of `keepId` replaced whatever the device showed before: the device holds
   * one prototype, so every other shown prototype ends. Waiters settle as dismissed.
   */
  replaceShown(deviceId: string, keepId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.scope.deviceId === deviceId && entry.id !== keepId && entry.shown) {
        this.remove(entry);
      }
    }
    this.pruneSources();
  }

  dismiss(deviceId: string, id?: string): void {
    for (const entry of this.entries.values()) {
      if (entry.scope.deviceId === deviceId && (id === undefined || entry.id === id)) {
        this.remove(entry);
      }
    }
    this.pruneSources();
  }

  releaseSession(sessionUuid: string): void {
    // The store forgets every scope on each device the session touched, so release exactly
    // those devices here: status and event state must never disagree about a co-tenant.
    const devices = new Set(this.store.clearSession(sessionUuid));
    for (const entry of this.entries.values()) {
      if (entry.scope.sessionUuid === sessionUuid || devices.has(entry.scope.deviceId)) {
        this.remove(entry);
      }
    }
    this.pruneSources();
  }

  releaseDevice(deviceId: string): void {
    this.store.clearDevice(deviceId);
    this.dismiss(deviceId);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.remove(entry);
    }
    this.pruneSources();
  }

  private watch(scope: PrototypeScope, id: string, client: PrototypeEventSource): Entry {
    const key = scopeKey(scope, id);
    let entry = this.entries.get(key);
    if (!entry) {
      const owned = Array.from(this.entries.values()).some(
        (known) => known.scope.deviceId === scope.deviceId && known.id === id,
      );
      if (owned) {
        throw new ActionableError(
          "Prototype events belong to another session; show this id in the current session first.",
        );
      }
      entry = {
        scope: { ...scope },
        id,
        buffer: new PrototypeEventBuffer(),
        shown: false,
        terminal: false,
        waiters: new Set(),
      };
      this.entries.set(key, entry);
    }
    if (!entry.terminal) {
      this.subscribe(scope.deviceId, client);
    }
    return entry;
  }

  private subscribe(deviceId: string, client: PrototypeEventSource): void {
    const existing = this.sources.get(deviceId);
    if (existing?.client === client) {
      return;
    }
    existing?.unsubscribe();
    this.sources.set(deviceId, {
      client,
      unsubscribe: client.onPrototypeEvent((event) => this.receive(deviceId, event)),
    });
  }

  private receive(deviceId: string, event: PrototypeEvent): void {
    const entry = Array.from(this.entries.values()).find(
      (known) => known.scope.deviceId === deviceId && known.id === event.id,
    );
    if (!entry || entry.terminal || !entry.buffer.push(event)) {
      return;
    }
    this.store.recordEvent(entry.scope, event);
    if (event.kind === "dismissed") {
      entry.shown = false;
      entry.terminal = true;
      this.store.dismissed(entry.scope, entry.id);
    }
    for (const notify of [...entry.waiters]) {
      notify();
    }
    this.pruneSources();
    try {
      this.telemetry?.recordPrototypeEvent(entry.scope, event);
    } catch (error) {
      logger.warn(`[PrototypeEventCoordinator] Telemetry recording failed: ${errorMessage(error)}`);
    }
  }

  private take(entry: Entry, filter: PrototypeEventFilter): PrototypeAwaitResult | undefined {
    const event = entry.buffer.take(filter);
    if (!event) {
      return entry.terminal ? { ...entry.buffer.status(), reason: "dismissed" } : undefined;
    }
    if (event.kind === "dismissed") {
      entry.buffer.clear();
    }
    const delivered = {
      id: event.id,
      sequence: event.sequence,
      kind: event.kind,
      name: event.name,
      payload: event.payload,
      state: event.state,
      pages: event.pages,
      timestamp: event.timestamp,
    };
    return { event: delivered, ...entry.buffer.status() };
  }

  private async wait(
    entry: Entry,
    options: PrototypeEventFilter & { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PrototypeAwaitResult> {
    let notify = () => {};
    const event = new Promise<PrototypeAwaitResult>((resolve) => {
      notify = () => {
        if (options.signal?.aborted) {
          return;
        }
        const result = this.take(entry, options);
        if (result) {
          entry.waiters.delete(notify);
          resolve(result);
        }
      };
      entry.waiters.add(notify);
    });
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<PrototypeAwaitResult>((resolve) => {
      timeoutHandle = this.timer.setTimeout(() => {
        entry.waiters.delete(notify);
        resolve({ ...entry.buffer.status(), timedOut: true });
      }, options.timeoutMs ?? DEFAULT_PROTOTYPE_EVENT_TIMEOUT_MS);
    });
    try {
      return await raceWithDeadline([event, timeout], {
        timer: this.timer,
        signal: options.signal,
        label: "Await prototype event",
      });
    } finally {
      if (timeoutHandle !== undefined) {
        this.timer.clearTimeout(timeoutHandle);
      }
      entry.waiters.delete(notify);
      this.dropConsumedTerminal(entry);
      if (
        !entry.shown &&
        !entry.terminal &&
        entry.buffer.status().lastSequence === undefined &&
        entry.waiters.size === 0
      ) {
        this.entries.delete(scopeKey(entry.scope, entry.id));
      }
      this.pruneSources();
    }
  }

  /** A device-dismissed entry has nothing left to deliver once its events are consumed. */
  private dropConsumedTerminal(entry: Entry): void {
    if (
      entry.terminal &&
      entry.waiters.size === 0 &&
      entry.buffer.status().pendingCount === 0 &&
      this.entries.get(scopeKey(entry.scope, entry.id)) === entry
    ) {
      this.entries.delete(scopeKey(entry.scope, entry.id));
    }
  }

  private remove(entry: Entry): void {
    entry.buffer.clear();
    entry.shown = false;
    entry.terminal = true;
    for (const notify of [...entry.waiters]) {
      notify();
    }
    this.entries.delete(scopeKey(entry.scope, entry.id));
  }

  private pruneSources(): void {
    for (const [deviceId, source] of this.sources) {
      const listening = Array.from(this.entries.values()).some(
        (entry) => entry.scope.deviceId === deviceId && !entry.terminal,
      );
      if (!listening) {
        source.unsubscribe();
        this.sources.delete(deviceId);
      }
    }
  }
}
