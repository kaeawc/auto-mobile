/**
 * Definition of a declarative mock backend (#14271): json-server style collections, canned routes,
 * seeded latency and faults. Plain data, no code; every binding in a route body is a placeholder.
 */
import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import type { PrototypeRequestJson } from "./prototypeRequestProtocol";

export const MAX_MOCK_BACKENDS = 16;
export const MAX_MOCK_COLLECTIONS = 16;
export const MAX_MOCK_ROUTES = 64;
export const MAX_MOCK_FAULTS = 16;
/** Collection data plus routes, as JSON text. */
export const MAX_MOCK_BACKEND_BYTES = 1024 * 1024;
/** A mock document file: up to every backend at its own size cap, with JSON overhead. */
export const MAX_MOCK_DOCUMENT_BYTES = 2 * MAX_MOCK_BACKEND_BYTES;
export const MAX_MOCK_LATENCY_MS = 10_000;
export const MAX_MOCK_ROUTE_DELAY_MS = 10_000;
export const MAX_MOCK_ACTORS = 16;
export const MAX_MOCK_ACTOR_STEPS = 64;
export const MAX_MOCK_ACTOR_DELAY_MS = 600_000;
export const MIN_MOCK_ACTOR_EVERY_MS = 100;
export const MAX_MOCK_ACTOR_RUNS = 10_000;

const MAX_DEPTH = contract.limits.MAX_PROTOTYPE_DATA_DEPTH;

export const MOCK_BACKEND_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** `/feed/:id` — literal segments and `:name` parameters. */
const ROUTE_PATH_BODY =
  /\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*))*|\//
    .source;
const ROUTE_PATH = new RegExp(`^(?:${ROUTE_PATH_BODY})$`);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const jsonValue: z.ZodType<PrototypeRequestJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);

function depthOf(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map(depthOf));
  }
  if (typeof value === "object" && value !== null) {
    return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  }
  return 0;
}

/**
 * An id a request path and a cursor can both name: a non-empty string or a finite number. `.` and
 * `..` are refused because URL normalization turns them into path navigation, so the item would
 * exist but could never be addressed.
 */
export function isMockItemId(id: unknown): id is string | number {
  return (
    (typeof id === "string" && id !== "" && id !== "." && id !== "..") ||
    (typeof id === "number" && Number.isFinite(id))
  );
}

const itemSchema = z
  .record(jsonValue)
  .refine((item) => depthOf(item) <= MAX_DEPTH, `items may nest at most ${MAX_DEPTH} levels`)
  .refine(
    (item) => isMockItemId(item.id),
    "every item needs an id: a number or a non-empty string other than . and ..",
  );

const collectionSchema = z
  .array(itemSchema)
  .max(contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS)
  .refine((items) => {
    const ids = items.filter((item) => item.id !== undefined).map((item) => String(item.id));
    return new Set(ids).size === ids.length;
  }, "item ids must be unique within a collection");

const routeSchema = z
  .object({
    method: z.enum(METHODS),
    path: z.string().regex(ROUTE_PATH, "path must look like /feed/:id"),
    status: z.number().int().min(100).max(599).optional(),
    headers: z.record(z.string().max(1024)).optional(),
    body: jsonValue.optional(),
    delayMs: z.number().int().min(0).max(MAX_MOCK_ROUTE_DELAY_MS).optional(),
  })
  .strict()
  .refine((route) => depthOf(route.body) <= MAX_DEPTH, `body may nest at most ${MAX_DEPTH} levels`);

const faultSchema = z
  .object({
    path: z.string().regex(ROUTE_PATH),
    method: z.enum(METHODS).optional(),
    status: z.number().int().min(400).max(599),
    every: z.number().int().min(1).max(1_000_000).optional(),
    rate: z.number().gt(0).max(1).optional(),
  })
  .strict()
  .refine((fault) => (fault.every === undefined) !== (fault.rate === undefined), {
    message: "a fault takes exactly one of every or rate",
  });

const ACTOR_ROUTE = new RegExp(`^(?:${METHODS.join("|")}) (?:${ROUTE_PATH_BODY})$`);
/** Steps the issue names that need a piece mock backends do not have yet (rooms, maps, push). */
const UNSUPPORTED_STEPS = {
  publish: "mock backends have no realtime channels yet",
  advance: "mock backends have no routes along a polyline yet",
  notify: "mock backends cannot deliver simulated push yet",
} as const;

const actorDelay = z.number().int().min(0).max(MAX_MOCK_ACTOR_DELAY_MS);

const actorStepSchema = z
  .object({
    afterMs: actorDelay.optional(),
    append: z.string().regex(COLLECTION_NAME).optional(),
    update: z.string().regex(COLLECTION_NAME).optional(),
    remove: z.string().regex(COLLECTION_NAME).optional(),
    id: z.union([z.string().min(1).max(256), z.number().finite()]).optional(),
    value: z.record(jsonValue).optional(),
    publish: z.unknown().optional(),
    advance: z.unknown().optional(),
    notify: z.unknown().optional(),
  })
  .strict()
  .superRefine((step, context) => {
    for (const [key, why] of Object.entries(UNSUPPORTED_STEPS)) {
      if (step[key as keyof typeof UNSUPPORTED_STEPS] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is not supported: ${why}`,
        });
      }
    }
    const kinds = (["append", "update", "remove"] as const).filter(
      (kind) => step[kind] !== undefined,
    );
    if (kinds.length > 1) {
      context.addIssue({
        code: "custom",
        message: "a step takes at most one of append, update or remove",
      });
    } else if (kinds.length === 0 && step.afterMs === undefined) {
      context.addIssue({
        code: "custom",
        message: "a step needs append, update, remove or afterMs",
      });
    }
    const kind = kinds.length === 1 ? kinds[0] : undefined;
    if ((kind === "append" || kind === "update") !== (step.value !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "value goes with append or update",
      });
    }
    if ((kind === "update" || kind === "remove") !== (step.id !== undefined)) {
      context.addIssue({ code: "custom", path: ["id"], message: "id goes with update or remove" });
    }
    if (depthOf(step.value) > MAX_DEPTH) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `value may nest at most ${MAX_DEPTH} levels`,
      });
    }
  });

const actorSchema = z
  .object({
    on: z
      .object({ route: z.string().regex(ACTOR_ROUTE, 'route must look like "POST /feed/:id"') })
      .strict()
      .optional(),
    every: z.number().int().min(MIN_MOCK_ACTOR_EVERY_MS).max(MAX_MOCK_ACTOR_DELAY_MS).optional(),
    maxRuns: z.number().int().min(1).max(MAX_MOCK_ACTOR_RUNS).optional(),
    afterMs: actorDelay.optional(),
    do: z.array(actorStepSchema).min(1).max(MAX_MOCK_ACTOR_STEPS),
  })
  .strict()
  .refine((actor) => (actor.on === undefined) !== (actor.every === undefined), {
    message: "an actor takes exactly one of on or every",
  })
  .refine((actor) => (actor.every === undefined) === (actor.maxRuns === undefined), {
    message: "every needs maxRuns, and maxRuns goes only with every",
  });

const latencySchema = z
  .object({
    min: z.number().int().min(0).max(MAX_MOCK_LATENCY_MS),
    max: z.number().int().min(0).max(MAX_MOCK_LATENCY_MS),
  })
  .strict()
  .refine((latency) => latency.min <= latency.max, "latencyMs.min cannot exceed max");

export const mockBackendDefinitionSchema = z
  .object({
    collections: z
      .record(collectionSchema)
      .refine((collections) => Object.keys(collections).length <= MAX_MOCK_COLLECTIONS, {
        message: `at most ${MAX_MOCK_COLLECTIONS} collections`,
      })
      .refine(
        (collections) => Object.keys(collections).every((name) => COLLECTION_NAME.test(name)),
        {
          message: "collection names must match [A-Za-z][A-Za-z0-9_-]{0,31}",
        },
      )
      .optional(),
    routes: z.array(routeSchema).max(MAX_MOCK_ROUTES).optional(),
    faults: z.array(faultSchema).max(MAX_MOCK_FAULTS).optional(),
    latencyMs: latencySchema.optional(),
    /** Seed of the random stream behind latency and `rate` faults. */
    seed: z.number().int().min(0).max(0xffff_ffff).optional(),
    /** Timed and route-triggered writes to the collections (#14211). */
    actors: z.array(actorSchema).max(MAX_MOCK_ACTORS).optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    const names = new Set(Object.keys(definition.collections ?? {}));
    for (const [at, actor] of (definition.actors ?? []).entries()) {
      for (const [index, step] of actor.do.entries()) {
        const name = step.append ?? step.update ?? step.remove;
        if (name !== undefined && !names.has(name)) {
          context.addIssue({
            code: "custom",
            path: ["actors", at, "do", index],
            message: `no collection named "${name}"`,
          });
        }
      }
    }
  })
  .refine(
    (definition) =>
      Buffer.byteLength(JSON.stringify([definition.collections, definition.routes])) <=
      MAX_MOCK_BACKEND_BYTES,
    `a backend holds at most ${MAX_MOCK_BACKEND_BYTES} bytes of collections and routes`,
  );

export type MockBackendDefinition = z.infer<typeof mockBackendDefinitionSchema>;
export type MockItem = Record<string, PrototypeRequestJson>;
export type MockRoute = z.infer<typeof routeSchema>;
export type MockFault = z.infer<typeof faultSchema>;
export type MockActor = z.infer<typeof actorSchema>;
export type MockActorStep = z.infer<typeof actorStepSchema>;
