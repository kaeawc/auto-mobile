import { ActionableError } from "../../models";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { ShownSpecJson } from "./PrototypeShownSpecs";

/** Host-side grouping of design alternatives (#16345); never sent to the device. */
export interface PrototypeSpecVariant {
  readonly group: string;
  readonly label: string;
}

export type PrototypePlatformName = "android" | "ios";

/** One spec the host saw land: the first show is 1, each later show or landed patch adds one. */
export interface PrototypeSpecRevision {
  readonly revision: number;
  readonly operation: "show" | "patch";
  readonly spec: ShownSpecJson;
  /** The device `revision` a landed patch reported, when it reported one. */
  readonly deviceRevision?: number;
  /** Platform of the device the spec was shown or patched on, when known. */
  readonly platform?: PrototypePlatformName;
  /** Host clock time the revision was recorded. */
  readonly time: number;
  readonly variant?: PrototypeSpecVariant;
  /** UTF-8 size of the spec JSON, counted against {@link MAX_PROTOTYPE_SPEC_REVISION_BYTES}. */
  readonly bytes: number;
}

/** What the shown-spec mirror reports when a show or patch is acknowledged. */
export interface PrototypeSpecRevisionRecorder {
  recordShow(
    id: string,
    shown: {
      spec: ShownSpecJson;
      platform?: PrototypePlatformName;
      variant?: PrototypeSpecVariant;
    },
  ): void;
  recordPatch(
    id: string,
    patched: { spec: ShownSpecJson; platform?: PrototypePlatformName; deviceRevision?: number },
  ): void;
}

export type PrototypeSpecRevisionEvent =
  | { readonly kind: "revision"; readonly id: string; readonly revision: number }
  /** The byte cap dropped older revisions of an id other than the one just revised. */
  | { readonly kind: "pruned"; readonly id: string }
  | { readonly kind: "evicted"; readonly id: string };

/** Read side for resources: kept history per id and change notifications. */
export interface PrototypeSpecRevisionSource {
  /** Ids with at least one kept revision, in the order they first appeared. */
  ids(): readonly string[];
  /** Kept revisions of an id, oldest first. Throws an ActionableError for an unknown id. */
  history(id: string): readonly PrototypeSpecRevision[];
  /** One kept revision (default the latest). Throws an ActionableError when unknown or evicted. */
  revision(id: string, revision?: number): PrototypeSpecRevision;
  onRevision(listener: (event: PrototypeSpecRevisionEvent) => void): () => void;
}

/** Revisions kept per prototype id. */
export const MAX_PROTOTYPE_SPEC_REVISIONS = 20;
/**
 * Spec JSON bytes kept across every id. Older revisions go first; each id's latest revision is
 * kept until only latest revisions remain, then the least recently revised ids are dropped whole.
 */
export const MAX_PROTOTYPE_SPEC_REVISION_BYTES = 32 * 1024 * 1024;

interface History {
  readonly order: number;
  /** Next revision number to assign. */
  next: number;
  lastSequence: number;
  variant?: PrototypeSpecVariant;
  readonly kept: (PrototypeSpecRevision & { readonly sequence: number })[];
}

/** In-memory spec revisions for the daemon session (#16345). Device state edits never add one. */
export class PrototypeSpecRevisions
  implements PrototypeSpecRevisionRecorder, PrototypeSpecRevisionSource
{
  private readonly histories = new Map<string, History>();
  private readonly listeners = new Set<(event: PrototypeSpecRevisionEvent) => void>();
  /** Next revision number of each id evicted whole, so a later show never reuses a number. */
  private readonly retired = new Map<string, number>();
  private sequence = 0;
  private order = 0;
  private totalBytes = 0;

  constructor(
    private readonly clock: Pick<Timer, "now">,
    private readonly limits = {
      revisions: MAX_PROTOTYPE_SPEC_REVISIONS,
      bytes: MAX_PROTOTYPE_SPEC_REVISION_BYTES,
    },
  ) {}

  recordShow(
    id: string,
    shown: {
      spec: ShownSpecJson;
      platform?: PrototypePlatformName;
      variant?: PrototypeSpecVariant;
    },
  ): void {
    const history = this.historyFor(id);
    // Each show states its variant afresh; a show without one leaves the group.
    history.variant = shown.variant ? { ...shown.variant } : undefined;
    this.append(id, history, { operation: "show", spec: shown.spec, platform: shown.platform });
  }

  recordPatch(
    id: string,
    patched: { spec: ShownSpecJson; platform?: PrototypePlatformName; deviceRevision?: number },
  ): void {
    this.append(id, this.historyFor(id), { operation: "patch", ...patched });
  }

  ids(): readonly string[] {
    return [...this.histories.entries()]
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([id]) => id);
  }

  history(id: string): readonly PrototypeSpecRevision[] {
    return this.known(id).kept.map(({ sequence: _sequence, ...revision }) => revision);
  }

  revision(id: string, revision?: number): PrototypeSpecRevision {
    const kept = this.history(id);
    const latest = kept.at(-1)!;
    if (revision === undefined) {
      return latest;
    }
    const found = kept.find((entry) => entry.revision === revision);
    if (found) {
      return found;
    }
    const oldest = kept[0]!.revision;
    const keptList = kept.map((entry) => entry.revision).join(", ");
    if (Number.isInteger(revision) && revision >= 1 && revision < oldest) {
      throw new ActionableError(
        `Revision ${revision} of prototype "${id}" was evicted; the oldest kept revision is ${oldest}. Kept revisions: ${keptList}.`,
      );
    }
    throw new ActionableError(
      `Prototype "${id}" has no revision ${revision}. Kept revisions: ${keptList} (latest ${latest.revision}).`,
    );
  }

  onRevision(listener: (event: PrototypeSpecRevisionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private known(id: string): History {
    const history = this.histories.get(id);
    if (!history || history.kept.length === 0) {
      const known = this.ids();
      throw new ActionableError(
        `Unknown prototype "${id}": no show of it was acknowledged in this daemon session. Known prototypes: ${known.length > 0 ? known.join(", ") : "none"}. Show it with the prototype tool first.`,
      );
    }
    return history;
  }

  private historyFor(id: string): History {
    const existing = this.histories.get(id);
    if (existing) {
      return existing;
    }
    const next = this.retired.get(id) ?? 1;
    this.retired.delete(id);
    const created: History = { order: ++this.order, next, lastSequence: 0, kept: [] };
    this.histories.set(id, created);
    return created;
  }

  private append(
    id: string,
    history: History,
    entry: Pick<PrototypeSpecRevision, "operation" | "spec" | "platform" | "deviceRevision">,
  ): void {
    const spec = structuredClone(entry.spec);
    const bytes = Buffer.byteLength(JSON.stringify(spec));
    const sequence = ++this.sequence;
    const revision = history.next++;
    history.lastSequence = sequence;
    history.kept.push({
      revision,
      operation: entry.operation,
      spec,
      ...(entry.deviceRevision === undefined ? {} : { deviceRevision: entry.deviceRevision }),
      ...(entry.platform === undefined ? {} : { platform: entry.platform }),
      time: this.clock.now(),
      ...(history.variant ? { variant: { ...history.variant } } : {}),
      bytes,
      sequence,
    });
    this.totalBytes += bytes;
    while (history.kept.length > this.limits.revisions) {
      this.totalBytes -= history.kept.shift()!.bytes;
    }
    const { pruned, evicted } = this.enforceByteCap(id);
    this.emit({ kind: "revision", id, revision });
    for (const other of pruned) {
      if (other !== id && !evicted.includes(other)) {
        this.emit({ kind: "pruned", id: other });
      }
    }
    for (const gone of evicted) {
      this.emit({ kind: "evicted", id: gone });
    }
  }

  /** Drops the oldest non-latest revisions, then whole least recently revised ids, never `current`. */
  private enforceByteCap(current: string): { pruned: Set<string>; evicted: string[] } {
    const pruned = new Set<string>();
    while (this.totalBytes > this.limits.bytes) {
      const older = [...this.histories.entries()]
        .filter(([, history]) => history.kept.length > 1)
        .sort(([, a], [, b]) => a.kept[0]!.sequence - b.kept[0]!.sequence)[0];
      if (!older) {
        break;
      }
      this.totalBytes -= older[1].kept.shift()!.bytes;
      pruned.add(older[0]);
    }
    const evicted: string[] = [];
    while (this.totalBytes > this.limits.bytes) {
      const stale = [...this.histories.entries()]
        .filter(([id]) => id !== current)
        .sort(([, a], [, b]) => a.lastSequence - b.lastSequence)[0];
      if (!stale) {
        break;
      }
      const [id, history] = stale;
      this.totalBytes -= history.kept.reduce((sum, entry) => sum + entry.bytes, 0);
      this.histories.delete(id);
      this.retired.set(id, history.next);
      evicted.push(id);
    }
    return { pruned, evicted };
  }

  private emit(event: PrototypeSpecRevisionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A failing resource listener must not undo the show or patch that was acknowledged.
        logger.warn(`[prototype] spec revision listener failed for ${event.id}`, error);
      }
    }
  }
}
