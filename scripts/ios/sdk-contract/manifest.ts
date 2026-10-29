import { z } from "zod";

/**
 * The manifest Playground writes for one SDK contract run
 * (`ios/Playground/Sources/SdkContract/SdkContractManifest.swift`). Keep the two in step:
 * the Swift encoder omits nil optionals, so every optional here means "not asserted".
 */
export const SDK_CONTRACT_MANIFEST_SCHEMA_VERSION = 1;

const expectedNetworkEventSchema = z.object({
  caseName: z.string().min(1),
  url: z.string().min(1),
  method: z.string().min(1),
  protocolName: z.string().min(1),
  direction: z.string().min(1),
  requestId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  statusCode: z.number().int().optional(),
  requestBodySize: z.number().int().nonnegative().optional(),
  responseBodySize: z.number().int().nonnegative().optional(),
  responseBody: z.string().optional(),
  metadata: z.record(z.string()).optional(),
  redactedRequestHeaders: z.array(z.string().min(1)).optional(),
});

const sdkEnvelopeSchema = z.object({
  eventType: z.string().min(1),
  payload: z.string(),
});

const sdkContractManifestSchema = z.object({
  schemaVersion: z.literal(SDK_CONTRACT_MANIFEST_SCHEMA_VERSION),
  runId: z.string().min(1),
  scenario: z.string().min(1),
  status: z.enum(["complete", "failed"]),
  failure: z.string().optional(),
  bundleId: z.string().optional(),
  network: z.array(expectedNetworkEventSchema),
  events: z.array(sdkEnvelopeSchema),
  undecodableBatches: z.number().int().nonnegative(),
});

export type ExpectedNetworkEvent = z.infer<typeof expectedNetworkEventSchema>;
export type SdkContractManifest = z.infer<typeof sdkContractManifestSchema>;

export type ManifestParseResult =
  | { success: true; manifest: SdkContractManifest }
  | { success: false; error: string };

export function parseSdkContractManifest(text: string): ManifestParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { success: false, error: `manifest is not JSON: ${String(error)}` };
  }
  const parsed = sdkContractManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return { success: false, error: `manifest does not match schema: ${issues.join("; ")}` };
  }
  return { success: true, manifest: parsed.data };
}
