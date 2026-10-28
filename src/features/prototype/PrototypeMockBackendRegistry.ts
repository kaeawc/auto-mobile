/**
 * The mock backends of one daemon session (#14271): defined by id, replaced idempotently, and kept
 * until cleared or the session ends. Holding a backend does not open a port or touch the network.
 */
import { ActionableError } from "../../models/ActionableError";
import type { IdGenerator } from "../../utils/IdGenerator";
import { defaultRandom, type Random } from "../../utils/Random";
import { SeededRandom } from "../../utils/SeededRandom";
import type { Timer } from "../../utils/SystemTimer";
import { PrototypeMockBackend } from "./PrototypeMockBackend";
import {
  MAX_MOCK_BACKENDS,
  MOCK_BACKEND_ID,
  mockBackendDefinitionSchema,
} from "./prototypeMockSchema";

export interface MockBackendRegistryDeps {
  ids: IdGenerator;
  timer: Pick<Timer, "sleep">;
  /** The stream behind a backend: seeded when the definition has a seed, so a run replays. */
  createRandom?: (seed: number | undefined) => Random;
}

const defaultCreateRandom = (seed: number | undefined): Random =>
  seed === undefined ? defaultRandom : new SeededRandom(seed);

export class PrototypeMockBackendRegistry {
  private readonly backends = new Map<string, PrototypeMockBackend>();

  constructor(private readonly deps: MockBackendRegistryDeps) {}

  /** Defines or replaces `backendId`; replacing resets its collections, faults and log. */
  define(backendId: string, definition: unknown): void {
    if (!MOCK_BACKEND_ID.test(backendId)) {
      throw new ActionableError(
        `Mock backend id "${backendId}" must match ${MOCK_BACKEND_ID.source}.`,
      );
    }
    const parsed = mockBackendDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ActionableError(
        `Invalid mock backend definition at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
      );
    }
    if (!this.backends.has(backendId) && this.backends.size >= MAX_MOCK_BACKENDS) {
      throw new ActionableError(
        `At most ${MAX_MOCK_BACKENDS} mock backends may be defined; clear one first.`,
      );
    }
    const createRandom = this.deps.createRandom ?? defaultCreateRandom;
    this.backends.set(
      backendId,
      new PrototypeMockBackend(parsed.data, {
        random: createRandom(parsed.data.seed),
        ids: this.deps.ids,
        timer: this.deps.timer,
      }),
    );
  }

  get(backendId: string): PrototypeMockBackend | undefined {
    return this.backends.get(backendId);
  }

  clear(backendId: string): boolean {
    return this.backends.delete(backendId);
  }

  /** Session end. */
  clearAll(): void {
    this.backends.clear();
  }

  ids(): string[] {
    return [...this.backends.keys()];
  }
}
