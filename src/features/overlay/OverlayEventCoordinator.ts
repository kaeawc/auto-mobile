import type { OverlayEvent } from "../observe/android/ctrlProxyProtocol";
import type { OverlayScope, OverlayStatusStore } from "./OverlayStatusStore";
import {
  OverlayEventBuffer,
  type OverlayEventCounts,
  type OverlayEventFilter,
} from "./OverlayEventBuffer";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { ActionableError } from "../../models/ActionableError";

export const DEFAULT_OVERLAY_EVENT_TIMEOUT_MS = 30_000;
export const MAX_OVERLAY_EVENT_TIMEOUT_MS = 60_000;
export interface OverlayEventSource {
  onOverlayEvent(listener: (event: OverlayEvent) => void): () => void;
}
export interface OverlayAwaitResult extends OverlayEventCounts {
  event?: Omit<OverlayEvent, "type">;
  timedOut?: true;
  reason?: "dismissed";
}
interface Entry {
  scope: OverlayScope;
  id: string;
  buffer: OverlayEventBuffer;
  shown: boolean;
  terminal: boolean;
  waiters: Set<() => void>;
}
const scopeKey = (scope: OverlayScope, id: string) =>
  JSON.stringify([scope.sessionUuid ?? null, scope.deviceId, id]);

/** One subscription per device client; only the current device/id owner receives pushes. */
export class OverlayEventCoordinator {
  private readonly entries = new Map<string, Entry>();
  private readonly sources = new Map<
    string,
    { client: OverlayEventSource; unsubscribe: () => void }
  >();

  constructor(
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">,
    private readonly store: OverlayStatusStore,
  ) {}

  /** Subscribe before show dispatch so a push during the request cannot be lost. */
  show(scope: OverlayScope, id: string, client: OverlayEventSource): void {
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
    entry.buffer.clear();
    entry.shown = true;
    entry.terminal = false;
    this.subscribe(scope.deviceId, client);
  }

  isDismissed(scope: OverlayScope, id: string): boolean {
    return this.entries.get(scopeKey(scope, id))?.terminal ?? false;
  }

  counts(scope: OverlayScope, id: string): OverlayEventCounts | undefined {
    return this.entries.get(scopeKey(scope, id))?.buffer.status();
  }

  async awaitEvent(
    scope: OverlayScope,
    id: string,
    client: OverlayEventSource,
    options: OverlayEventFilter & { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<OverlayAwaitResult> {
    options.signal?.throwIfAborted();
    const entry = this.watch(scope, id, client);
    const immediate = this.take(entry, options);
    if (immediate) {
      this.pruneSources();
      return immediate;
    }
    return this.wait(entry, options);
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
    this.store.clearSession(sessionUuid);
    for (const entry of this.entries.values()) {
      if (entry.scope.sessionUuid === sessionUuid) {
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

  private watch(scope: OverlayScope, id: string, client: OverlayEventSource): Entry {
    const key = scopeKey(scope, id);
    let entry = this.entries.get(key);
    if (!entry) {
      const owned = Array.from(this.entries.values()).some(
        (known) => known.scope.deviceId === scope.deviceId && known.id === id,
      );
      if (owned) {
        throw new ActionableError(
          "Overlay events belong to another session; show this id in the current session first.",
        );
      }
      entry = {
        scope: { ...scope },
        id,
        buffer: new OverlayEventBuffer(),
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

  private subscribe(deviceId: string, client: OverlayEventSource): void {
    const existing = this.sources.get(deviceId);
    if (existing?.client === client) {
      return;
    }
    existing?.unsubscribe();
    this.sources.set(deviceId, {
      client,
      unsubscribe: client.onOverlayEvent((event) => this.receive(deviceId, event)),
    });
  }

  private receive(deviceId: string, event: OverlayEvent): void {
    const entry = Array.from(this.entries.values()).find(
      (known) => known.scope.deviceId === deviceId && known.id === event.id,
    );
    if (!entry || entry.terminal || !entry.buffer.push(event)) {
      return;
    }
    if (event.kind === "dismissed") {
      entry.shown = false;
      entry.terminal = true;
      this.store.dismissed(entry.scope, entry.id);
    }
    for (const notify of [...entry.waiters]) {
      notify();
    }
    this.pruneSources();
  }

  private take(entry: Entry, filter: OverlayEventFilter): OverlayAwaitResult | undefined {
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
    options: OverlayEventFilter & { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<OverlayAwaitResult> {
    let notify = () => {};
    const event = new Promise<OverlayAwaitResult>((resolve) => {
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
    const timeout = new Promise<OverlayAwaitResult>((resolve) => {
      timeoutHandle = this.timer.setTimeout(() => {
        entry.waiters.delete(notify);
        resolve({ ...entry.buffer.status(), timedOut: true });
      }, options.timeoutMs ?? DEFAULT_OVERLAY_EVENT_TIMEOUT_MS);
    });
    try {
      return await raceWithDeadline([event, timeout], {
        timer: this.timer,
        signal: options.signal,
        label: "Await overlay event",
      });
    } finally {
      if (timeoutHandle !== undefined) {
        this.timer.clearTimeout(timeoutHandle);
      }
      entry.waiters.delete(notify);
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
