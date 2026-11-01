import { z } from "zod";

/**
 * Host-side model of the iOS SDK observation bridge's values (#5159). The Swift source of truth is
 * `ObservationWireModels.swift` in `ios/sdk-wire`; CtrlProxy relays them in `sdk_observation_result`
 * and `sdk_action_result`.
 */

const boundsSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
});

export interface IosSdkObservationNode {
  id: string;
  role: string;
  label?: string;
  value?: string;
  bounds: z.infer<typeof boundsSchema>;
  enabled: boolean;
  visible: boolean;
  focused: boolean;
  children: IosSdkObservationNode[];
}

const nodeSchema: z.ZodType<IosSdkObservationNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    role: z.string(),
    label: z.string().optional(),
    value: z.string().optional(),
    bounds: boundsSchema,
    enabled: z.boolean(),
    visible: z.boolean(),
    focused: z.boolean(),
    children: z.array(nodeSchema),
  }),
);

export const iosSdkObservationSchema = z.object({
  bundleId: z.string().optional(),
  /** Changes with every capture. A Swift UInt64; values above 2^53 lose precision. */
  captureIdentity: z.number().int().nonnegative(),
  orientation: z.string(),
  coordinateSpace: z.string(),
  bounds: boundsSchema,
  root: nodeSchema.optional(),
  focusedElementId: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
});
export type IosSdkObservation = z.infer<typeof iosSdkObservationSchema>;

export const iosSdkActionResultSchema = z.object({
  status: z.enum(["accepted", "rejected", "cancelled"]),
  reason: z.string().optional(),
  durationMs: z.number().default(0),
  nextObservationIdentity: z.number().int().nonnegative().optional(),
});
export type IosSdkActionResult = z.infer<typeof iosSdkActionResultSchema>;

interface Point {
  x: number;
  y: number;
}

/**
 * One bridge action, in Swift's synthesized `Codable` enum shape: the case name keys an object of
 * its labeled values. Every action names the observation it was resolved against.
 */
export type IosSdkAction =
  | { tap: { observationIdentity: number; elementId: string } }
  | { longPress: { observationIdentity: number; elementId: string; durationMs: number } }
  | { swipe: { observationIdentity: number; start: Point; end: Point; durationMs: number } }
  | { drag: { observationIdentity: number; elementId: string; end: Point; durationMs: number } }
  | { pinch: { observationIdentity: number; elementId: string; scale: number; durationMs: number } }
  | { insertText: { observationIdentity: number; elementId: string; text: string } }
  | { clearText: { observationIdentity: number; elementId: string } }
  | { back: { observationIdentity: number } }
  | { scroll: { observationIdentity: number; elementId?: string; delta: Point } };

/** Typed reasons an observation-bridge command produced no result. */
export const IOS_SDK_BRIDGE_FAILURES = [
  "bridge_unavailable",
  "app_not_active",
  "invalid_action",
  "bad_reply",
] as const;
export type IosSdkBridgeFailure = (typeof IOS_SDK_BRIDGE_FAILURES)[number];

/** Narrow a runner failure code; one this daemon does not know reads as `bad_reply`. */
export function iosSdkBridgeFailure(value: unknown): IosSdkBridgeFailure | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return IOS_SDK_BRIDGE_FAILURES.find((known) => known === value) ?? "bad_reply";
}
