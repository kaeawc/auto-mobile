import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { logger } from "../utils/logger";
import {
  buildPerformanceAuditResponse,
  PERFORMANCE_RESULTS_LIMIT_MAX,
  type PerformanceAuditQueryArgs,
} from "./performanceData";
import { queryParamsToRecord } from "./queryParamValidation";

const PERFORMANCE_RESOURCE_URIS = {
  BASE: "automobile:performance-results",
} as const;

const PERFORMANCE_QUERY_KEYS = ["startTime", "endTime", "limit", "offset", "deviceId"] as const;
const PERFORMANCE_QUERY_TEMPLATE = `${PERFORMANCE_RESOURCE_URIS.BASE}?{params}`;
const PERFORMANCE_QUERY_PARAM_KEYS = new Set<string>(PERFORMANCE_QUERY_KEYS);

function parseInteger(
  value: string | undefined,
  label: string,
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  const min = options.min ?? 0;
  if (parsed < min) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function parseTimestampParam(value: string | undefined, label: string): string | number | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  if (/^-?\d+$/.test(normalized)) {
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
    return parsed;
  }

  return normalized;
}

function parsePerformanceParams(
  params: Record<string, string>
): Pick<PerformanceAuditQueryArgs, "startTime" | "endTime" | "limit" | "offset" | "deviceId"> {
  const unknownKeys = Object.keys(params).filter(key => !PERFORMANCE_QUERY_PARAM_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown query parameters: ${unknownKeys.join(", ")}`);
  }

  const startTime = parseTimestampParam(params.startTime, "startTime");
  const endTime = parseTimestampParam(params.endTime, "endTime");
  const limitRaw = params.limit?.trim();
  const offsetRaw = params.offset?.trim();
  const deviceIdRaw = params.deviceId?.trim();

  return {
    startTime,
    endTime,
    limit: parseInteger(limitRaw, "limit", { min: 1, max: PERFORMANCE_RESULTS_LIMIT_MAX }),
    offset: parseInteger(offsetRaw, "offset", { min: 0 }),
    deviceId: deviceIdRaw || undefined,
  };
}

function buildPerformanceUri(options: PerformanceAuditQueryArgs): string {
  const query = new URLSearchParams();
  if (options.startTime !== undefined) {
    query.set("startTime", String(options.startTime));
  }
  if (options.endTime !== undefined) {
    query.set("endTime", String(options.endTime));
  }
  if (options.limit !== undefined) {
    query.set("limit", options.limit.toString());
  }
  if (options.offset !== undefined) {
    query.set("offset", options.offset.toString());
  }
  if (options.deviceId !== undefined) {
    query.set("deviceId", options.deviceId);
  }

  const queryString = query.toString();
  return queryString ? `${PERFORMANCE_RESOURCE_URIS.BASE}?${queryString}` : PERFORMANCE_RESOURCE_URIS.BASE;
}

async function getPerformanceResource(
  args: PerformanceAuditQueryArgs,
  uri: string
): Promise<ResourceContent> {
  try {
    const response = await buildPerformanceAuditResponse(args);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(response, null, 2)
    };
  } catch (error) {
    logger.error(`[PerformanceResources] Failed to get performance audit results: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to retrieve performance audit results: ${error}`
      }, null, 2)
    };
  }
}

export function registerPerformanceResources(): void {
  ResourceRegistry.register(
    PERFORMANCE_RESOURCE_URIS.BASE,
    "Performance Results",
    "List UI performance audit results from the local database.",
    "application/json",
    () => getPerformanceResource({}, PERFORMANCE_RESOURCE_URIS.BASE)
  );

  ResourceRegistry.registerTemplate(
    PERFORMANCE_QUERY_TEMPLATE,
    "Performance Results",
    "List UI performance audit results from the local database.",
    "application/json",
    async params => {
    try {
      const queryParams = queryParamsToRecord(params.params ?? "");
      const options = parsePerformanceParams(queryParams);
      const uri = buildPerformanceUri(options);
      return getPerformanceResource(options, uri);
    } catch (error) {
      logger.error(`[PerformanceResources] Failed to parse query params: ${error}`);
      return {
        uri: PERFORMANCE_RESOURCE_URIS.BASE,
        mimeType: "application/json",
        text: JSON.stringify({
          error: `Invalid performance query parameters: ${error}`
        }, null, 2)
      };
    }
  });

  logger.info("[PerformanceResources] Registered performance resources");
}
