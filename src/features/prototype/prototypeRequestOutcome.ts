import type { PrototypeData } from "./prototypeSpec";
import { applyPrototypeDataWrite } from "./prototypeDataWrite";
import { prototypeRequestMetaPath, type PrototypeRequestStatus } from "./prototypeRequest";
import {
  PROTOTYPE_REQUEST_ERROR_CODES,
  type PrototypeResponseMessage,
} from "./prototypeRequestProtocol";

/**
 * What a `request` does with its response (#12523). The executable reference for device runtimes
 * (host mirror and tests use it too), so Kotlin and Swift copy one set of rules:
 *
 * - 2xx: the body is written to `into` with the `setData` semantics (parsed JSON as is, anything
 *   else as a string, an empty body as `""`), then the metadata to `<into>__meta`; the status key
 *   becomes `success` and `onSuccess` runs.
 * - any other status, a transport failure, or a body `/data` cannot hold: `into` is left
 *   untouched, the metadata (with `error`) is still written, the status key becomes `error` and
 *   `onError` runs.
 */

/** Errors the response handling adds to the host's transport codes. */
export const PROTOTYPE_REQUEST_RESPONSE_ERROR_CODES = ["http_error", "invalid_response"] as const;
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
  /** The data after the `into` and meta writes (the input data when nothing could be written). */
  data: PrototypeData;
  meta: PrototypeRequestMeta;
  wroteInto: boolean;
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

function writeMeta(data: PrototypeData, into: string, meta: PrototypeRequestMeta): PrototypeData {
  const path = prototypeRequestMetaPath(into);
  const { headers, ...withoutHeaders } = meta;
  const attempts = headers === undefined ? [meta] : [meta, withoutHeaders];
  for (const value of attempts) {
    const written = applyPrototypeDataWrite(data, { op: "set", path, value });
    if (written.success) {
      return written.data;
    }
  }
  return data;
}

/**
 * Applies one response. `into` is the authored `/data/<pointer>` with repeat `{index}` already
 * bound; without it nothing is written to data but the status and follow-up still follow the
 * response.
 */
export function applyPrototypeRequestOutcome(
  data: PrototypeData,
  into: string | undefined,
  response: PrototypeResponseMessage,
): PrototypeRequestOutcomeResult {
  let meta = metaOf(response);
  let next = data;
  let wroteInto = false;
  if (response.ok && meta.error === undefined && into !== undefined) {
    const written = applyPrototypeDataWrite(next, {
      op: "set",
      path: into,
      value: response.body === null ? "" : response.body,
    });
    if (written.success) {
      next = written.data;
      wroteInto = true;
    } else {
      meta = { ...meta, error: { code: "invalid_response", message: written.error.message } };
    }
  }
  if (into !== undefined) {
    next = writeMeta(next, into, meta);
  }
  return {
    status: meta.error === undefined ? "success" : "error",
    data: next,
    meta,
    wroteInto,
  };
}
