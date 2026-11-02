import { z } from "zod";

/**
 * The manifest Playground writes for one SDK contract run
 * (`ios/Playground/Sources/SdkContract/SdkContractManifest.swift`). Keep the two in step:
 * the Swift encoder omits nil optionals, so every optional here means "not asserted".
 */
export const SDK_CONTRACT_MANIFEST_SCHEMA_VERSION = 4;

const expectedNetworkEventSchema = z.object({
  caseName: z.string().min(1),
  url: z.string().min(1),
  method: z.string().min(1),
  /** Absent for `URLProtocol` records, which carry no protocol name or direction. */
  protocolName: z.string().min(1).optional(),
  direction: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  statusCode: z.number().int().optional(),
  requestBodySize: z.number().int().nonnegative().optional(),
  responseBodySize: z.number().int().nonnegative().optional(),
  responseBody: z.string().optional(),
  metadata: z.record(z.string()).optional(),
  redactedRequestHeaders: z.array(z.string().min(1)).optional(),
  /** `null` asserts the record carries no error; absent does not assert it. */
  error: z.string().nullable().optional(),
});

/** What the fault scenario observed on the client side of one case. */
const faultCaseObservationSchema = z.object({
  caseName: z.string().min(1),
  url: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  elapsedMs: z.number().nonnegative(),
  /** `<domain>:<code>` or `posix:<code>`; absent when the exchange completed. */
  clientError: z.string().min(1).optional(),
});

/** One `transportCapabilities()` descriptor exactly as the SDK's Codable type encodes it. */
const transportDescriptorSchema = z.object({
  id: z.string().min(1),
  state: z.string().min(1),
  reason: z.string().optional(),
  faultEnforcement: z.string().optional(),
  faultActions: z.array(z.string()).optional(),
});

const capabilityObservationSchema = z.object({
  beforeRegistration: z.array(transportDescriptorSchema),
  afterRegistration: z.array(transportDescriptorSchema),
});

/** One action the observation scenario's contract bridge executed. */
const observationHostActionSchema = z.object({
  kind: z.string().min(1),
  elementId: z.string().min(1).optional(),
  observationIdentity: z.number().int().nonnegative(),
  text: z.string().optional(),
});

const observationHostLogSchema = z.object({
  captures: z.number().int().nonnegative(),
  actions: z.array(observationHostActionSchema),
});

/** The storage registration a storage scenario applied. */
const storageRegistrationSchema = z.object({
  allowKeychainDeletion: z.boolean(),
  keychainEntries: z.array(
    z.object({ service: z.string(), account: z.string(), accessGroup: z.string() }),
  ),
  uncoordinatedSuites: z.array(z.string().min(1)),
  hostCoordinatedSuites: z.array(z.string().min(1)),
  coreDataStores: z.array(
    z.object({
      identifier: z.string().min(1),
      queryable: z.boolean(),
      appGroup: z.string().min(1).optional(),
      coordination: z.string().min(1).optional(),
    }),
  ),
  secretWritten: z.boolean(),
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
  faults: z.array(faultCaseObservationSchema),
  capabilities: capabilityObservationSchema.optional(),
  observation: observationHostLogSchema.optional(),
  navigation: z
    .object({
      deviceClass: z.enum(["ipad", "iphone"]),
      multiScene: z.enum(["complete", "not-applicable"]),
      sceneIdentifiers: z.array(z.string().min(1)),
      events: z.array(
        z.object({
          source: z.string(),
          destination: z.string(),
          sequenceNumber: z.number().int().positive(),
          sceneIdentifier: z.string().optional(),
          transitionCompleted: z.boolean(),
        }),
      ),
    })
    .optional(),
  storage: storageRegistrationSchema.optional(),
  events: z.array(sdkEnvelopeSchema),
  undecodableBatches: z.number().int().nonnegative(),
});

export type ExpectedNetworkEvent = z.infer<typeof expectedNetworkEventSchema>;
export type FaultCaseObservation = z.infer<typeof faultCaseObservationSchema>;
export type TransportDescriptor = z.infer<typeof transportDescriptorSchema>;
export type ObservationHostAction = z.infer<typeof observationHostActionSchema>;
export type ObservationHostLog = z.infer<typeof observationHostLogSchema>;
export type StorageRegistration = z.infer<typeof storageRegistrationSchema>;
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
