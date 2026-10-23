import { open, stat } from "node:fs/promises";
import type {
  KnownPerformanceTrace,
  PerformanceTraceManager,
} from "../features/performanceTrace/PerformanceTraceManager";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { resolveActiveSessionDevice, type ActiveSessionResolver } from "./activeSessionDevice";
import {
  getRequestedResourceUri,
  ResourceRegistry,
  type ResourceContent,
  type ResourceReadContext,
} from "./resourceRegistry";

export const PERFORMANCE_TRACE_RESOURCE_TEMPLATE =
  "automobile:device-session/{sessionUuid}/performance-traces/{traceId}{?offset,maxBytes}";

/** Largest artifact slice returned in one read; callers page with `offset`. */
export const PERFORMANCE_TRACE_MAX_BYTES_LIMIT = 1024 * 1024;

const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What the resource needs to know about the artifact on the host. */
export interface TraceArtifactReader {
  /** `undefined` when the artifact is gone; directories (iOS `.trace` bundles) have no bytes. */
  stat(path: string): Promise<{ isFile: boolean; size: number } | undefined>;
  readRange(path: string, offset: number, length: number): Promise<Buffer>;
}

export const nodeTraceArtifactReader: TraceArtifactReader = {
  async stat(path) {
    try {
      const info = await stat(path);
      return { isFile: info.isFile(), size: info.size };
    } catch (error) {
      // A missing artifact is an expected state (cleaned temp dir), reported as such.
      logger.debug(`[PerformanceTraceResources] stat ${path} failed: ${errorMessage(error)}`);
      return undefined;
    }
  },
  async readRange(path, offset, length) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

export interface PerformanceTraceResourceDependencies {
  manager: Pick<PerformanceTraceManager, "lookup">;
  resolveActiveSession: ActiveSessionResolver;
  artifacts: TraceArtifactReader;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    logger.debug(`[PerformanceTraceResources] undecodable segment ${value}: ${error}`);
    return value;
  }
}

function jsonResponse(uri: string, body: object): ResourceContent {
  return { uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) };
}

function jsonError(uri: string, code: string, error: string): ResourceContent {
  return jsonResponse(uri, { code, error });
}

function parseNonNegativeInt(
  name: string,
  raw: string | undefined,
  max: number,
): number | undefined | string {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    return `${name} must be an integer from 0 to ${max}.`;
  }
  return parsed;
}

interface SliceRequest {
  offset: number;
  maxBytes: number | undefined;
}

function parseSlice(params: Record<string, string>): SliceRequest | string {
  const offset = parseNonNegativeInt("offset", params.offset, Number.MAX_SAFE_INTEGER);
  const maxBytes = parseNonNegativeInt(
    "maxBytes",
    params.maxBytes,
    PERFORMANCE_TRACE_MAX_BYTES_LIMIT,
  );
  if (typeof offset === "string") {
    return offset;
  }
  if (typeof maxBytes === "string") {
    return maxBytes;
  }
  return { offset: offset ?? 0, maxBytes };
}

async function describeArtifact(
  deps: PerformanceTraceResourceDependencies,
  known: KnownPerformanceTrace,
  slice: SliceRequest,
): Promise<object> {
  const path = known.result.artifactPath;
  const info = await deps.artifacts.stat(path);
  if (!info) {
    return { available: false };
  }
  if (!info.isFile) {
    // iOS `.trace` is a bundle directory; its summary is the portable output.
    return { available: true, kind: "directory" };
  }
  const base = { available: true, kind: "file", byteCount: info.size };
  if (slice.maxBytes === undefined || slice.maxBytes === 0) {
    return base;
  }
  const length = Math.min(slice.maxBytes, Math.max(0, info.size - slice.offset));
  const bytes =
    length > 0 ? await deps.artifacts.readRange(path, slice.offset, length) : Buffer.alloc(0);
  return {
    ...base,
    offset: slice.offset,
    returnedBytes: bytes.byteLength,
    truncated: slice.offset + bytes.byteLength < info.size,
    base64: bytes.toString("base64"),
  };
}

function createPerformanceTraceHandler(deps: PerformanceTraceResourceDependencies) {
  return async (
    params: Record<string, string>,
    context: ResourceReadContext,
  ): Promise<ResourceContent> => {
    const { sessionUuid: rawSessionUuid, traceId: rawTraceId } = params;
    const sessionUuid = safeDecode(rawSessionUuid);
    const uri =
      getRequestedResourceUri(params) ??
      `automobile:device-session/${rawSessionUuid}/performance-traces/${rawTraceId}`;

    // Binding first, before any parsing or device access, exactly as for crash reports.
    if (context.sessionUuid !== sessionUuid) {
      return jsonError(
        uri,
        "SESSION_NOT_BOUND",
        "This resource can only be read by its bound device session.",
      );
    }
    const activeSession = deps.resolveActiveSession(sessionUuid);
    if (!activeSession) {
      return jsonError(
        uri,
        "SESSION_NOT_ACTIVE",
        `No active device session found for sessionUuid ${sessionUuid}.`,
      );
    }
    const traceId = safeDecode(rawTraceId);
    const slice = parseSlice(params);
    if (typeof slice === "string" || !TRACE_ID_PATTERN.test(traceId)) {
      return jsonError(
        uri,
        "INVALID_REQUEST",
        typeof slice === "string" ? slice : "traceId is not a valid performance trace id.",
      );
    }
    const known = deps.manager.lookup(traceId);
    // A trace from another session or device is indistinguishable from a missing one.
    if (
      !known ||
      known.ownerSessionUuid !== sessionUuid ||
      known.result.deviceId !== activeSession.device.deviceId
    ) {
      return jsonError(uri, "NOT_FOUND", `No performance trace ${traceId} for this session.`);
    }
    try {
      return jsonResponse(uri, {
        ...known.result,
        artifact: await describeArtifact(deps, known, slice),
      });
    } catch (error) {
      context.signal?.throwIfAborted();
      logger.warn(
        `[PerformanceTraceResources] read ${traceId} failed: ${errorMessage(error)}`,
        error,
      );
      return jsonError(uri, "READ_FAILED", errorMessage(error));
    }
  };
}

export function registerPerformanceTraceResources(
  manager: Pick<PerformanceTraceManager, "lookup">,
  overrides: Partial<Omit<PerformanceTraceResourceDependencies, "manager">> = {},
): void {
  const deps: PerformanceTraceResourceDependencies = {
    resolveActiveSession: resolveActiveSessionDevice,
    artifacts: nodeTraceArtifactReader,
    ...overrides,
    manager,
  };
  ResourceRegistry.registerTemplateWithReadContext(
    PERFORMANCE_TRACE_RESOURCE_TEMPLATE,
    "Performance Trace",
    "The state, bounded summary and warnings of a `performanceTrace` the caller's session " +
      "started, plus the artifact's size. `maxBytes` (up to 1 MiB) with `offset` returns " +
      "base64 slices of a single-file artifact (Perfetto); iOS `.trace` bundles are directories.",
    "application/json",
    createPerformanceTraceHandler(deps),
  );
}
