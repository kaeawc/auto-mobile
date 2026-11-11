import type { PrototypeAssetRequestOptions } from "../../observe/android/CtrlProxyPrototypes";
import type {
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
  PrototypeState,
  PrototypeStatusEntry,
} from "../../observe/android/ctrlProxyProtocol";
import type { Timer } from "../../../utils/SystemTimer";
import type { AndroidPrototypeClient } from "../androidPrototypeTransport";
import { applyPrototypePatch } from "../prototypePatch";
import { prototypeDataPointerTokens } from "../prototypeData";
import type { PrototypePatchReply, PrototypePatchRequest } from "../prototypePatchWire";
import { collectPrototypeAssetReferences } from "../prototypeAssetReferences";
import { walkPrototypeNodes } from "../prototypeNodeChildren";
import type { PrototypeAssetUpload } from "../prototypeAssets";
import type { PrototypeData, PrototypeJson, PrototypeSpec } from "../prototypeSpec";
import type { PrototypeShowOverrides } from "../PrototypeTransport";
import { VIRTUAL_PROTOTYPE_CAPABILITIES } from "./headlessPrototypeMode";

/** One prototype the virtual device is showing. */
interface ShownPrototype {
  spec: Record<string, unknown>;
  state: PrototypeState;
  pages: Record<string, number>;
  lastSequence: number;
  revision: number;
  /**
   * The revision that last wrote each state key, as CtrlProxy keeps it: a `/state` patch from a
   * `baseRevision` older than a key it touches conflicts, whoever wrote the key.
   */
  stateRevisions: Map<string, number>;
}

/** What a renderer reports when the user acts on a shown prototype. */
export interface VirtualPrototypeInput {
  id: string;
  kind: PrototypeEvent["kind"];
  name: string | null;
  payload?: PrototypeJson;
  /** State keys the input changed, merged into the prototype's state before the event is sent. */
  state?: PrototypeState;
  pages?: Record<string, number>;
}

const SAVED_REFUSAL: PrototypeResult = {
  success: false,
  error: "The headless virtual device has no saved prototypes.",
};

/** The state keys a patch's `/state/<key>` ops address. */
function patchedStateKeys(patch: PrototypePatchRequest): string[] {
  const keys = patch.ops.flatMap((op) =>
    op.op !== "replaceNode" && op.path.startsWith("/state/")
      ? [prototypeDataPointerTokens(op.path.slice("/state".length))[0]]
      : [],
  );
  return [...new Set(keys)].filter((key) => key !== undefined);
}

/** Stamps every key whose value differs between the two states with `revision`. */
function stampChangedKeys(
  revisions: Map<string, number>,
  before: PrototypeState,
  after: PrototypeState,
  revision: number,
): void {
  new Set([...Object.keys(before), ...Object.keys(after)]).forEach((key) => {
    if (before[key] !== after[key]) {
      revisions.set(key, revision);
    }
  });
}

/** The refusal CtrlProxy answers a `/state` patch with before applying it, if any. */
function stateGuardReply(
  entry: ShownPrototype,
  patch: PrototypePatchRequest,
): PrototypePatchReply | undefined {
  const keys = patchedStateKeys(patch);
  if (keys.length === 0) {
    return undefined;
  }
  const { baseRevision } = patch;
  if (baseRevision === undefined || baseRevision > entry.revision) {
    return {
      success: false,
      delivery: "answered",
      revision: entry.revision,
      error:
        baseRevision === undefined
          ? "baseRevision is required when a patch has /state ops"
          : `baseRevision ${baseRevision} is newer than the device revision ${entry.revision}`,
    };
  }
  const stale = keys.filter((key) => (entry.stateRevisions.get(key) ?? 0) > baseRevision);
  if (stale.length === 0) {
    return undefined;
  }
  const state = Object.fromEntries(
    stale.filter((key) => key in entry.state).map((key) => [key, entry.state[key]]),
  );
  return {
    success: false,
    delivery: "answered",
    error: "conflict",
    revision: entry.revision,
    conflict: { revision: entry.revision, state },
  };
}

/**
 * Each root pager's position, as `PrototypeRuntime.boundPages` derives it on a show: a numeric
 * value of its `stateKey` first, else the retained position, else 0, clamped to its pages.
 */
function boundPages(
  spec: Record<string, unknown>,
  state: PrototypeState,
  previous: Record<string, number>,
): Record<string, number> {
  const pages: Record<string, number> = {};
  walkPrototypeNodes({ root: spec.root }, (node) => {
    if (node.type !== "pager" || typeof node.id !== "string") {
      return;
    }
    const last = Math.max(0, (Array.isArray(node.children) ? node.children.length : 0) - 1);
    const bound = typeof node.stateKey === "string" ? state[node.stateKey] : undefined;
    const position = typeof bound === "number" ? Math.trunc(bound) : (previous[node.id] ?? 0);
    pages[node.id] = Math.min(Math.max(position, 0), last);
  });
  return pages;
}

const asState = (value: unknown): PrototypeState =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (structuredClone(value) as PrototypeState)
    : {};

/**
 * The headless virtual device (#17974): answers the Android prototype protocol from memory, so the
 * prototype tool's shared Android path (gates, status, events, patch mirror, web resource) runs
 * unchanged with no CtrlProxy. Rendering is the host web renderer's; this holds only state.
 */
export class VirtualPrototypeDevice implements AndroidPrototypeClient {
  private readonly shown = new Map<string, ShownPrototype>();
  private readonly assets = new Set<string>();
  private readonly listeners = new Set<(event: PrototypeEvent) => void>();
  private readonly capabilities: ReadonlySet<string>;

  constructor(
    private readonly clock: Pick<Timer, "now">,
    capabilities: readonly string[] = VIRTUAL_PROTOTYPE_CAPABILITIES,
  ) {
    this.capabilities = new Set(capabilities);
  }

  async supportsCommand(name: string): Promise<boolean> {
    return this.capabilities.has(name);
  }

  async requestShowPrototype(
    spec: PrototypeSpec,
    _timeoutMs?: number,
    _perf?: unknown,
    overrides: PrototypeShowOverrides = {},
  ): Promise<PrototypeResult> {
    const previous = this.shown.get(spec.id);
    if (overrides.replaceOthers !== false) {
      [...this.shown.keys()].filter((id) => id !== spec.id).forEach((id) => this.shown.delete(id));
    }
    const inPlace = previous !== undefined && overrides.reset !== true;
    const copy: Record<string, unknown> = { ...structuredClone(spec) };
    const state = asState(copy.state);
    const revision = (previous?.revision ?? 0) + 1;
    this.shown.set(spec.id, {
      spec: copy,
      state,
      pages: boundPages(copy, state, inPlace ? previous.pages : {}),
      // Sequences never rewind for an id, as on hardware.
      lastSequence: previous?.lastSequence ?? 0,
      revision,
      // A show writes every declared key, as CtrlProxy stamps them with the show's revision.
      stateRevisions: new Map(Object.keys(state).map((key) => [key, revision])),
    });
    const missing = this.missingAssets(copy);
    return {
      success: true,
      totalTimeMs: 0,
      timestamp: this.clock.now(),
      ...(missing.length > 0 ? { missingAssets: missing } : {}),
    };
  }

  async requestDismissPrototype(target: PrototypeDismiss): Promise<PrototypeResult> {
    if (target.all) {
      this.shown.clear();
    } else if (target.id !== undefined) {
      this.shown.delete(target.id);
    }
    return { success: true, totalTimeMs: 0, timestamp: this.clock.now() };
  }

  async requestPatchPrototype(patch: PrototypePatchRequest): Promise<PrototypePatchReply> {
    const entry = this.shown.get(patch.id);
    if (!entry) {
      return {
        success: false,
        delivery: "answered",
        error: `No prototype with id ${patch.id} is shown on the virtual device.`,
      };
    }
    const refused = stateGuardReply(entry, patch);
    if (refused) {
      return refused;
    }
    const current = { ...entry.spec, state: entry.state };
    const applied = applyPrototypePatch(current, patch.ops);
    if (!applied.success) {
      return {
        success: false,
        delivery: "answered",
        error: `Invalid patch at ${applied.error.path}: ${applied.error.message}`,
      };
    }
    const state = asState(applied.spec.state);
    entry.revision += 1;
    stampChangedKeys(entry.stateRevisions, entry.state, state, entry.revision);
    entry.spec = applied.spec;
    entry.state = state;
    return { success: true, delivery: "answered", revision: entry.revision, totalTimeMs: 0 };
  }

  async requestInspectPrototypes(): Promise<PrototypeResult> {
    const prototypes: PrototypeStatusEntry[] = [...this.shown.entries()].map(([id, entry]) => ({
      id,
      persistent: false,
      state: { ...entry.state },
      pages: { ...entry.pages },
      lastSequence: entry.lastSequence,
      ...(entry.spec.data === undefined
        ? {}
        : { data: structuredClone(entry.spec.data) as PrototypeData }),
    }));
    return { success: true, prototypes, droppedEvents: 0, timestamp: this.clock.now() };
  }

  async requestPutPrototypeAsset(
    asset: PrototypeAssetUpload,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult> {
    options?.abortSignal?.throwIfAborted();
    options?.onDispatch?.();
    this.assets.add(asset.id);
    return { success: true, dispatched: true, acknowledged: true };
  }

  async requestRemovePrototypeAsset(
    id: string,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult> {
    options?.abortSignal?.throwIfAborted();
    options?.onDispatch?.();
    this.assets.delete(id);
    return { success: true, dispatched: true, acknowledged: true };
  }

  async requestSavePrototype(): Promise<PrototypeResult> {
    return SAVED_REFUSAL;
  }

  async requestListSavedPrototypes(): Promise<PrototypeResult> {
    return SAVED_REFUSAL;
  }

  async requestPinSavedPrototype(): Promise<PrototypeResult> {
    return SAVED_REFUSAL;
  }

  async requestDeleteSavedPrototype(): Promise<PrototypeResult> {
    return SAVED_REFUSAL;
  }

  onPrototypeEvent(listener: (event: PrototypeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Delivers a user input on a shown prototype as the device's `prototype_event` push, so
   * awaitEvent sees it exactly as from hardware. False when the id is not shown.
   */
  dispatch(input: VirtualPrototypeInput): boolean {
    const entry = this.shown.get(input.id);
    if (!entry) {
      return false;
    }
    if (input.state !== undefined) {
      const state = { ...entry.state, ...input.state };
      entry.revision += 1;
      stampChangedKeys(entry.stateRevisions, entry.state, state, entry.revision);
      entry.state = state;
    }
    if (input.pages !== undefined) {
      entry.pages = { ...entry.pages, ...input.pages };
    }
    entry.lastSequence += 1;
    const event: PrototypeEvent = {
      type: "prototype_event",
      timestamp: this.clock.now(),
      id: input.id,
      sequence: entry.lastSequence,
      kind: input.kind,
      name: input.name,
      payload: input.payload ?? null,
      state: { ...entry.state },
      pages: { ...entry.pages },
    };
    [...this.listeners].forEach((listener) => listener(event));
    return true;
  }

  /** Ids the virtual device is showing, oldest first. */
  shownIds(): string[] {
    return [...this.shown.keys()];
  }

  private missingAssets(spec: unknown): string[] {
    const { images, fonts, shaders } = collectPrototypeAssetReferences(spec);
    return [...images, ...fonts, ...shaders].filter((id) => !this.assets.has(id)).sort();
  }
}
