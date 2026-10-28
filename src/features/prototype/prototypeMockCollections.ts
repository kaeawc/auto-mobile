/**
 * json-server style REST over named collections for the mock backend (#14271):
 * `GET /<name>` with filters, `q` search, `_sort`, `_page`/`_limit` and cursor paging
 * (`after` + `size`), `GET /<name>/:id`, `POST`, `PATCH`, `PUT` and `DELETE`.
 */
import type { IdGenerator } from "../../utils/IdGenerator";
import type { PrototypeRequestJson } from "./prototypeRequestProtocol";
import type { MockItem } from "./prototypeMockSchema";
import contract from "../../../schemas/prototype-spec-contract.json";

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: PrototypeRequestJson | null;
}

export interface CollectionRequest {
  method: string;
  /** Path segments after the collection name, e.g. `["3"]` for `/posts/3`. */
  rest: string[];
  query: Record<string, string>;
  body: PrototypeRequestJson | undefined;
}

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const RESERVED_QUERY = new Set(["q", "_sort", "_page", "_limit", "after", "size"]);
const MAX_ITEMS = contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS;

const json = (
  status: number,
  body: PrototypeRequestJson,
  headers: Record<string, string> = {},
) => ({
  status,
  headers,
  body,
});
const error = (status: number, message: string): MockResponse => json(status, { error: message });

function isItem(value: PrototypeRequestJson | undefined): value is MockItem {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(a: PrototypeRequestJson | undefined, b: PrototypeRequestJson | undefined): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const left = String(a ?? "");
  const right = String(b ?? "");
  // Code-point order, so every runtime sorts strings identically.
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(items: MockItem[], sort: string | undefined): MockItem[] {
  if (sort === undefined || sort === "") {
    return items;
  }
  const descending = sort.startsWith("-");
  const field = descending ? sort.slice(1) : sort;
  // Array.prototype.sort is stable, so equal keys keep insertion order.
  return [...items].sort((a, b) => (descending ? -1 : 1) * compare(a[field], b[field]));
}

function filtered(items: MockItem[], query: Record<string, string>): MockItem[] {
  const equals = Object.entries(query).filter(([key]) => !RESERVED_QUERY.has(key));
  const needle = query.q?.toLowerCase();
  return items.filter(
    (item) =>
      equals.every(([key, value]) => String(item[key]) === value) &&
      (needle === undefined ||
        Object.values(item).some(
          (field) =>
            (typeof field === "string" || typeof field === "number") &&
            String(field).toLowerCase().includes(needle),
        )),
  );
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number | undefined {
  if (raw === undefined) {
    return fallback;
  }
  return /^[1-9][0-9]*$/.test(raw) && Number(raw) <= max ? Number(raw) : undefined;
}

function list(items: MockItem[], query: Record<string, string>): MockResponse {
  const matches = sorted(filtered(items, query), query._sort);
  if (query.after !== undefined || query.size !== undefined) {
    return cursorPage(matches, query);
  }
  if (query._page === undefined && query._limit === undefined) {
    return json(200, matches);
  }
  const limit = positiveInt(query._limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const page = positiveInt(query._page, 1, MAX_ITEMS);
  if (limit === undefined || page === undefined) {
    return error(400, "_page and _limit must be positive integers (_limit at most 100)");
  }
  return json(200, matches.slice((page - 1) * limit, page * limit), {
    "x-total-count": String(matches.length),
  });
}

function cursorPage(matches: MockItem[], query: Record<string, string>): MockResponse {
  const size = positiveInt(query.size, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  if (size === undefined) {
    return error(400, "size must be a positive integer of at most 100");
  }
  let start = 0;
  if (query.after !== undefined && query.after !== "") {
    const at = matches.findIndex((item) => String(item.id) === query.after);
    if (at === -1) {
      return error(400, "after names no item in this result");
    }
    start = at + 1;
  }
  const items = matches.slice(start, start + size);
  const more = start + size < matches.length;
  return json(200, { items, next: more ? (items[items.length - 1]?.id ?? null) : null });
}

function bodyItem(body: PrototypeRequestJson | undefined): MockItem | undefined {
  return isItem(body) ? body : undefined;
}

export interface CollectionDeps {
  ids: IdGenerator;
  /** Whether the backend, with this collection replaced by `next`, stays within its size budget. */
  fits(next: MockItem[]): boolean;
}

function withinBudget(items: MockItem[], deps: CollectionDeps): boolean {
  return items.length <= MAX_ITEMS && deps.fits(items);
}

/** Applies one request to a collection, mutating `items` in place for writes. */
export function answerCollection(
  items: MockItem[],
  request: CollectionRequest,
  deps: CollectionDeps,
): MockResponse {
  const [id, ...extra] = request.rest;
  if (extra.length > 0) {
    return error(404, "No such route");
  }
  if (id === undefined) {
    return answerWholeCollection(items, request, deps);
  }
  const index = items.findIndex((item) => String(item.id) === id);
  switch (request.method) {
    case "GET":
      return index === -1 ? error(404, "Not found") : json(200, items[index]!);
    case "PATCH":
    case "PUT":
      return replaceItem(items, index, request, deps);
    case "DELETE":
      return deleteItem(items, index);
    default:
      return error(405, `${request.method} is not allowed here`);
  }
}

function answerWholeCollection(
  items: MockItem[],
  request: CollectionRequest,
  deps: CollectionDeps,
): MockResponse {
  if (request.method === "GET") {
    return list(items, request.query);
  }
  if (request.method !== "POST") {
    return error(405, `${request.method} is not allowed here`);
  }
  const created = bodyItem(request.body);
  if (created === undefined) {
    return error(400, "Expected a JSON object body");
  }
  const item = created.id === undefined ? { ...created, id: deps.ids.next() } : created;
  if (items.some((existing) => String(existing.id) === String(item.id))) {
    return error(409, "An item with that id already exists");
  }
  const next = [...items, item];
  if (!withinBudget(next, deps)) {
    return error(413, "The collection is full");
  }
  items.push(item);
  return json(201, item);
}

function replaceItem(
  items: MockItem[],
  index: number,
  request: CollectionRequest,
  deps: CollectionDeps,
): MockResponse {
  const patch = bodyItem(request.body);
  if (patch === undefined) {
    return error(400, "Expected a JSON object body");
  }
  if (index === -1) {
    return error(404, "Not found");
  }
  const current = items[index]!;
  if (patch.id !== undefined && String(patch.id) !== String(current.id)) {
    return error(400, "The id of an item cannot change");
  }
  const updated: MockItem =
    request.method === "PATCH"
      ? { ...current, ...patch, id: current.id! }
      : { ...patch, id: current.id! };
  const next = items.map((item, at) => (at === index ? updated : item));
  if (!withinBudget(next, deps)) {
    return error(413, "The collection is full");
  }
  items[index] = updated;
  return json(200, updated);
}

function deleteItem(items: MockItem[], index: number): MockResponse {
  if (index === -1) {
    return error(404, "Not found");
  }
  items.splice(index, 1);
  return json(200, {});
}
