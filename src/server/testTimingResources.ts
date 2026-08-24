import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { logger } from "../utils/logger";
import {
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  queryParamsToRecord,
} from "./queryParamValidation";
import {
  buildTestTimingResponse,
  TEST_TIMING_LIMIT_MAX,
  type TestTimingQueryArgs,
} from "./testTimingData";

const TEST_TIMING_RESOURCE_URIS = {
  BASE: "automobile:test-timings",
} as const;

const TEST_TIMING_QUERY_TEMPLATE = `${TEST_TIMING_RESOURCE_URIS.BASE}?{params}`;
const TEST_TIMING_QUERY_PARAM_KEYS = new Set([
  "lookbackDays",
  "limit",
  "minSamples",
  "orderBy",
  "orderDirection",
  "testClass",
  "testMethod",
  "deviceId",
  "deviceName",
  "devicePlatform",
  "deviceType",
  "appVersion",
  "gitCommit",
  "targetSdk",
  "jdkVersion",
  "jvmTarget",
  "gradleVersion",
  "isCi",
  "sessionUuid",
] as const);

function parseTestTimingParams(params: Record<string, string>): TestTimingQueryArgs {
  const unknownKeys = Object.keys(params).filter((key) => !TEST_TIMING_QUERY_PARAM_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown query parameters: ${unknownKeys.join(", ")}`);
  }

  return {
    lookbackDays: optionalInteger(params.lookbackDays, "lookbackDays", { min: 1 }),
    limit: optionalInteger(params.limit, "limit", { min: 1, max: TEST_TIMING_LIMIT_MAX }),
    minSamples: optionalInteger(params.minSamples, "minSamples", { min: 0 }),
    orderBy: optionalEnum(params.orderBy, "orderBy", ["lastRun", "averageDuration", "sampleSize"]),
    orderDirection: optionalEnum(params.orderDirection, "orderDirection", ["asc", "desc"]),
    testClass: optionalString(params.testClass),
    testMethod: optionalString(params.testMethod),
    deviceId: optionalString(params.deviceId),
    deviceName: optionalString(params.deviceName),
    devicePlatform: optionalEnum(params.devicePlatform, "devicePlatform", ["android", "ios"]),
    deviceType: optionalEnum(params.deviceType, "deviceType", ["emulator", "simulator", "device"]),
    appVersion: optionalString(params.appVersion),
    gitCommit: optionalString(params.gitCommit),
    targetSdk: optionalInteger(params.targetSdk, "targetSdk", { min: 1 }),
    jdkVersion: optionalString(params.jdkVersion),
    jvmTarget: optionalString(params.jvmTarget),
    gradleVersion: optionalString(params.gradleVersion),
    isCi: optionalBoolean(params.isCi, "isCi"),
    sessionUuid: optionalString(params.sessionUuid),
  };
}

function buildTestTimingUri(options: TestTimingQueryArgs): string {
  const query = new URLSearchParams();
  if (options.lookbackDays !== undefined) {
    query.set("lookbackDays", options.lookbackDays.toString());
  }
  if (options.limit !== undefined) {
    query.set("limit", options.limit.toString());
  }
  if (options.minSamples !== undefined) {
    query.set("minSamples", options.minSamples.toString());
  }
  if (options.orderBy !== undefined) {
    query.set("orderBy", options.orderBy);
  }
  if (options.orderDirection !== undefined) {
    query.set("orderDirection", options.orderDirection);
  }
  if (options.testClass) {
    query.set("testClass", options.testClass);
  }
  if (options.testMethod) {
    query.set("testMethod", options.testMethod);
  }
  if (options.deviceId) {
    query.set("deviceId", options.deviceId);
  }
  if (options.deviceName) {
    query.set("deviceName", options.deviceName);
  }
  if (options.devicePlatform) {
    query.set("devicePlatform", options.devicePlatform);
  }
  if (options.deviceType) {
    query.set("deviceType", options.deviceType);
  }
  if (options.appVersion) {
    query.set("appVersion", options.appVersion);
  }
  if (options.gitCommit) {
    query.set("gitCommit", options.gitCommit);
  }
  if (options.targetSdk !== undefined) {
    query.set("targetSdk", options.targetSdk.toString());
  }
  if (options.jdkVersion) {
    query.set("jdkVersion", options.jdkVersion);
  }
  if (options.jvmTarget) {
    query.set("jvmTarget", options.jvmTarget);
  }
  if (options.gradleVersion) {
    query.set("gradleVersion", options.gradleVersion);
  }
  if (typeof options.isCi === "boolean") {
    query.set("isCi", options.isCi.toString());
  }
  if (options.sessionUuid) {
    query.set("sessionUuid", options.sessionUuid);
  }
  const queryString = query.toString();
  return queryString
    ? `${TEST_TIMING_RESOURCE_URIS.BASE}?${queryString}`
    : TEST_TIMING_RESOURCE_URIS.BASE;
}

async function getTestTimingResource(
  args: TestTimingQueryArgs,
  uri: string,
): Promise<ResourceContent> {
  try {
    const response = await buildTestTimingResponse(args);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(response, null, 2),
    };
  } catch (error) {
    logger.error(`[TestTimingResources] Failed to get test timing data: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to retrieve test timing data: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

export function registerTestTimingResources(): void {
  ResourceRegistry.register(
    TEST_TIMING_RESOURCE_URIS.BASE,
    "Test Timing History",
    "Historical aggregated test execution timing statistics.",
    "application/json",
    () => getTestTimingResource({}, TEST_TIMING_RESOURCE_URIS.BASE),
  );

  ResourceRegistry.registerTemplate(
    TEST_TIMING_QUERY_TEMPLATE,
    "Test Timing History",
    "Historical aggregated test execution timing statistics.",
    "application/json",
    async (params) => {
      try {
        const queryParams = queryParamsToRecord(params.params ?? "");
        const options = parseTestTimingParams(queryParams);
        const uri = buildTestTimingUri(options);
        return getTestTimingResource(options, uri);
      } catch (error) {
        logger.error(`[TestTimingResources] Failed to parse query params: ${error}`);
        return {
          uri: TEST_TIMING_RESOURCE_URIS.BASE,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              error: `Invalid test timing query parameters: ${error}`,
            },
            null,
            2,
          ),
        };
      }
    },
  );

  logger.info("[TestTimingResources] Registered test timing resources");
}
