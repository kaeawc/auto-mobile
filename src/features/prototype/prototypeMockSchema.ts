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
/** Room definitions per backend, and connections per room path. */
export const MAX_MOCK_ROOMS = 64;
export const MAX_MOCK_ROOM_MEMBERS = 64;
export const MAX_MOCK_ROOM_FRAMES = 64;
/** A timeline entry fires at most this long after its connection opened. */
export const MAX_MOCK_TIMELINE_MS = 600_000;

const MAX_DEPTH = contract.limits.MAX_PROTOTYPE_DATA_DEPTH;

export const MOCK_BACKEND_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** `/feed/:id` — literal segments and `:name` parameters. */
const ROUTE_PATH =
  /^\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*))*$|^\/$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const WRITE_METHODS = ["POST", "PUT", "PATCH"] as const;

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

const latencySchema = z
  .object({
    min: z.number().int().min(0).max(MAX_MOCK_LATENCY_MS),
    max: z.number().int().min(0).max(MAX_MOCK_LATENCY_MS),
  })
  .strict()
  .refine((latency) => latency.min <= latency.max, "latencyMs.min cannot exceed max");

const frameSchema = jsonValue.refine(
  (frame) => depthOf(frame) <= MAX_DEPTH,
  `a frame may nest at most ${MAX_DEPTH} levels`,
);

const roomSchema = z
  .object({
    path: z.string().regex(ROUTE_PATH, "path must look like /rooms/:roomId"),
    /** Sent to each connection as it opens, before anything else. */
    onConnect: z.array(frameSchema).max(MAX_MOCK_ROOM_FRAMES).optional(),
    /** A client's send comes back to that client. */
    echo: z.boolean().optional(),
    /** A client's send goes to every other member of the same room path. */
    relay: z.boolean().optional(),
    /** Scripted frames, each `afterMs` after its connection opened. */
    timeline: z
      .array(
        z
          .object({
            afterMs: z.number().int().min(0).max(MAX_MOCK_TIMELINE_MS),
            frame: frameSchema,
          })
          .strict(),
      )
      .max(MAX_MOCK_ROOM_FRAMES)
      .optional(),
  })
  .strict();

const broadcastSchema = z
  .object({
    /** The room path a write goes to, e.g. `/rooms/{item:/roomId}`. */
    room: z.string().startsWith("/").max(256),
    frame: frameSchema,
    /** The collection writes that broadcast; POST only by default. */
    on: z.array(z.enum(WRITE_METHODS)).min(1).max(3).optional(),
  })
  .strict();

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
    rooms: z.array(roomSchema).max(MAX_MOCK_ROOMS).optional(),
    /** `{collection: broadcast}`: a successful write to that collection is sent to a room. */
    broadcasts: z.record(broadcastSchema).optional(),
    latencyMs: latencySchema.optional(),
    /** Seed of the random stream behind latency and `rate` faults. */
    seed: z.number().int().min(0).max(0xffff_ffff).optional(),
  })
  .strict()
  .refine(
    (definition) =>
      Object.keys(definition.broadcasts ?? {}).every((name) =>
        Object.hasOwn(definition.collections ?? {}, name),
      ),
    { message: "every broadcasts key must name a collection", path: ["broadcasts"] },
  )
  .refine(
    (definition) => mockBackendBytes(definition, definition.collections) <= MAX_MOCK_BACKEND_BYTES,
    `a backend holds at most ${MAX_MOCK_BACKEND_BYTES} bytes of collections, routes, rooms and broadcasts`,
  );

/** The size the backend budget counts: collection data plus every static definition part. */
export function mockBackendBytes(
  definition: Pick<MockBackendDefinitionInput, "routes" | "rooms" | "broadcasts">,
  collections: unknown,
): number {
  return Buffer.byteLength(
    JSON.stringify([collections, definition.routes, definition.rooms, definition.broadcasts]),
  );
}

interface MockBackendDefinitionInput {
  routes?: unknown;
  rooms?: unknown;
  broadcasts?: unknown;
}

export type MockBackendDefinition = z.infer<typeof mockBackendDefinitionSchema>;
export type MockItem = Record<string, PrototypeRequestJson>;
export type MockRoute = z.infer<typeof routeSchema>;
export type MockFault = z.infer<typeof faultSchema>;
export type MockRoom = z.infer<typeof roomSchema>;
export type MockBroadcast = z.infer<typeof broadcastSchema>;
