import { z } from "zod/v4";

/** What a device sync reported; empty when the device installed everything it was sent. */
const deviceSyncShape = {
  deviceSynced: z.literal(false).optional(),
  warning: z.string().optional(),
  notInstalled: z.array(z.object({ mockId: z.string(), reason: z.string() })).optional(),
  deviceConfirmed: z.literal(false).optional(),
  note: z.string().optional(),
};

const simulatingErrorsSchema = z
  .object({
    errorType: z.string(),
    limit: z.number().optional(),
    remainingSeconds: z.number(),
  })
  .passthrough();

/** `network`: the host's network state for the device, plus how the device sync went. */
export const networkResultSchema = z
  .object({
    capturing: z.boolean(),
    notifFilter: z.enum(["all", "errors", "slow"]),
    notifDebounceMs: z.number(),
    slowThresholdMs: z.number(),
    simulatingErrors: simulatingErrorsSchema.optional(),
    ...deviceSyncShape,
  })
  .passthrough();

/** Mock rules on the device, keyed by `METHOD hostpath`; -1 is an unlimited rule. */
const mockSummarySchema = z.record(z.string(), z.number());

/** `mockNetwork`: failures throw, so the rule was always stored. */
export const mockNetworkResultSchema = z
  .object({
    mockId: z.string(),
    mocked: mockSummarySchema,
    ...deviceSyncShape,
  })
  .passthrough();

/** `clearMockNetwork`: an unknown mockId throws. */
export const clearMockNetworkResultSchema = z
  .object({
    cleared: z.number(),
    remaining: mockSummarySchema,
    ...deviceSyncShape,
  })
  .passthrough();

/** `getNetworkGraph`: captured requests aggregated per host and parameterized path. */
export const getNetworkGraphResultSchema = z
  .object({
    graph: z.array(
      z
        .object({
          scheme: z.string(),
          host: z.string(),
          paths: z.record(z.string(), z.unknown()),
        })
        .passthrough(),
    ),
    truncated: z.literal(true).optional(),
    maxEvents: z.number().optional(),
  })
  .passthrough();
