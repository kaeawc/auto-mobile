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
    this.defineAll({ [backendId]: definition });
  }

  /**
   * Defines or replaces every entry of `{backendId: definition}`, or none: all ids and definitions
   * are validated, and the backend cap checked for the ids that are new, before any is replaced.
   */
  defineAll(definitions: Record<string, unknown>): void {
    const parsed = Object.entries(definitions).map(([backendId, definition]) => {
      if (!MOCK_BACKEND_ID.test(backendId)) {
        throw new ActionableError(
          `Mock backend id "${backendId}" must match ${MOCK_BACKEND_ID.source}.`,
        );
      }
      const result = mockBackendDefinitionSchema.safeParse(definition);
      if (!result.success) {
        const issue = result.error.issues[0];
        const at = [backendId, ...(issue?.path ?? [])].join(".");
        throw new ActionableError(
          `Invalid mock backend definition at ${at}: ${issue?.message ?? "invalid"}`,
        );
      }
      return [backendId, result.data] as const;
    });
    const added = parsed.filter(([backendId]) => !this.backends.has(backendId)).length;
    if (this.backends.size + added > MAX_MOCK_BACKENDS) {
      throw new ActionableError(
        `At most ${MAX_MOCK_BACKENDS} mock backends may be defined; clear one first.`,
      );
    }
    const createRandom = this.deps.createRandom ?? defaultCreateRandom;
    for (const [backendId, definition] of parsed) {
      this.backends.set(
        backendId,
        new PrototypeMockBackend(definition, {
          random: createRandom(definition.seed),
          ids: this.deps.ids,
          timer: this.deps.timer,
        }),
      );
    }
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
