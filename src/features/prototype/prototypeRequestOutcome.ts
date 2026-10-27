import { prototypeDataPointerTokens, resolvePrototypeDataPointer } from "./prototypeData";
import { record } from "./prototypeTemplate";
import type { PrototypeData } from "./prototypeSpec";
import { applyPrototypeDataWrite } from "./prototypeDataWrite";
import { prototypeRequestMetaPath, type PrototypeRequestStatus } from "./prototypeRequest";
import {
  PROTOTYPE_REQUEST_ERROR_CODES,
  type PrototypeResponseMessage,
  type PrototypeRequestJson,
} from "./prototypeRequestProtocol";

/**
 * What a `request` does with its response (#12523). The executable reference for device runtimes
 * (host mirror and tests use it too), so Kotlin and Swift copy one set of rules:
 *
 * - With append, extract the response array from an object member and extend its target first.
 *   Into receives the remaining response. Both writes roll back together on failure.
 * - 2xx: the body is written to `into` with the `setData` semantics (parsed JSON as is, anything
 *   else as a string, an empty body as `""`), then the metadata to `<into>__meta`; the status key
 *   becomes `success` and `onSuccess` runs.
 * - any other status, a transport failure, or a body `/data` cannot hold: `into` is left
 *   untouched, the metadata (with `error`) is still written, the status key becomes `error` and
 *   `onError` runs.
 */

/** Errors the response handling adds to the host's transport codes. */
export const PROTOTYPE_REQUEST_RESPONSE_ERROR_CODES = ["http_error"] as const;
export const PROTOTYPE_REQUEST_META_ERROR_CODES = [
  ...PROTOTYPE_REQUEST_ERROR_CODES,
  ...PROTOTYPE_REQUEST_RESPONSE_ERROR_CODES,
] as const;
export type PrototypeRequestMetaErrorCode = (typeof PROTOTYPE_REQUEST_META_ERROR_CODES)[number];

/**
 * The value written at `<into>__meta`. `status` and `headers` are present once a response
 * arrived (header names lower-cased); `error` is present for every failure, including a non-2xx
 * status (`http_error`). If the whole value does not fit the `/data` write limit, `headers` is
 * dropped before giving up.
 */
export interface PrototypeRequestMeta {
  status?: number;
  headers?: Record<string, string>;
  durationMs: number;
  error?: { code: PrototypeRequestMetaErrorCode; message: string };
}

export interface PrototypeRequestOutcomeResult {
  /** Drives the status key and which follow-up list runs. */
  status: Extract<PrototypeRequestStatus, "success" | "error">;
  /** The data after the append, `into` and meta writes (the input data when nothing could be written). */
  data: PrototypeData;
  meta: PrototypeRequestMeta;
  wroteInto: boolean;
  /** Source rows appended, before trimming; zero for an error outcome. */
  appended: number;
}

function metaOf(response: PrototypeResponseMessage): PrototypeRequestMeta {
  if (!response.ok) {
    return { durationMs: response.durationMs, error: response.error };
  }
  const ok = response.status >= 200 && response.status < 300;
  return {
    status: response.status,
    headers: response.headers,
    durationMs: response.durationMs,
    ...(ok ? {} : { error: { code: "http_error", message: `HTTP ${response.status}` } }),
  };
}

/** The data with `__meta` set in the first form that fits (full, without headers), else undefined. */
function tryWriteMeta(
  data: PrototypeData,
  into: string,
  meta: PrototypeRequestMeta,
  minimal = false,
): PrototypeData | undefined {
  const path = prototypeRequestMetaPath(into);
  const { headers, ...withoutHeaders } = meta;
  const forms = headers === undefined ? [meta] : [meta, withoutHeaders];
  if (minimal && meta.error) {
    forms.push({ durationMs: meta.durationMs, error: meta.error });
  }
  for (const value of forms) {
    const written = applyPrototypeDataWrite(data, { op: "set", path, value });
    if (written.success) {
      return written.data;
    }
  }
  return undefined;
}

export interface PrototypeRequestAppend {
  from: string;
  to: string;
  maxItems?: number;
}

/** Only object members can be extracted; removing array elements would shift response indices. */
function appendSource(
  body: PrototypeRequestJson,
  from: string,
): { rest: PrototypeRequestJson; items: unknown[] } | undefined {
  const items = resolvePrototypeDataPointer(body, from);
  const split = from.lastIndexOf("/");
  const parent = split === 0 ? body : resolvePrototypeDataPointer(body, from.slice(0, split));
  if (!Array.isArray(items) || !record(parent)) {
    return undefined;
  }
  const rest = structuredClone(body);
  const owner = record(
    split === 0 ? rest : resolvePrototypeDataPointer(rest, from.slice(0, split)),
  );
  const key = prototypeDataPointerTokens(from).at(-1);
  if (!owner || key === undefined) {
    return undefined;
  }
  delete owner[key];
  return { rest, items };
}

/** Stage both body writes; callers discard this data on any failure, including meta failure. */
function writeResponse(
  data: PrototypeData,
  into: string | undefined,
  body: PrototypeRequestJson,
  append?: PrototypeRequestAppend,
):
  | { success: true; data: PrototypeData; appended: number; wroteInto: boolean }
  | { success: false; message: string } {
  let next = data;
  let appended = 0;
  if (append !== undefined) {
    const source = appendSource(body, append.from);
    if (!source) {
      return {
        success: false,
        message: "append.from does not resolve to an array in the response",
      };
    }
    const written = applyPrototypeDataWrite(next, {
      op: "extend",
      path: append.to,
      value: source.items,
      maxItems: append.maxItems,
    });
    if (!written.success) {
      return { success: false, message: `append.to ${written.error.message}` };
    }
    next = written.data;
    appended = source.items.length;
    body = source.rest;
  }
  if (into !== undefined) {
    const written = applyPrototypeDataWrite(next, {
      op: "set",
      path: into,
      value: body === null ? "" : body,
    });
    if (!written.success) {
      return { success: false, message: written.error.message };
    }
    next = written.data;
  }
  return { success: true, data: next, appended, wroteInto: into !== undefined };
}

const NO_ROOM_FOR_META = "response and metadata exceed the data limit";

/**
 * Applies one response. `into` is the authored `/data/<pointer>` with repeat `{index}` already
 * bound. Append extends its target first; into receives the remaining body. Without either,
 * only the status and follow-up are affected.
 */
export function applyPrototypeRequestOutcome(
  data: PrototypeData,
  into: string | undefined,
  response: PrototypeResponseMessage,
  append?: PrototypeRequestAppend,
): PrototypeRequestOutcomeResult {
  let meta = metaOf(response);
  let next = data;
  let wroteInto = false;
  let appended = 0;
  if (response.ok && meta.error === undefined) {
    const written = writeResponse(data, into, response.body, append);
    if (written.success) {
      next = written.data;
      appended = written.appended;
      wroteInto = written.wroteInto;
    } else {
      meta = { ...meta, error: { code: "invalid_response", message: written.message } };
    }
  }
  if (into !== undefined) {
    const withMeta = tryWriteMeta(next, into, meta);
    if (withMeta !== undefined) {
      next = withMeta;
    } else if (wroteInto || next !== data) {
      // The completion is atomic: a body that fits without room for any `__meta` is rolled back,
      // and the request is an error whose minimal metadata is written if even that fits.
      meta = { ...meta, error: { code: "invalid_response", message: NO_ROOM_FOR_META } };
      wroteInto = false;
      appended = 0;
      next = tryWriteMeta(data, into, meta, true) ?? data;
    }
  }
  return {
    status: meta.error === undefined ? "success" : "error",
    data: next,
    meta,
    wroteInto,
    appended,
  };
}
