import { Platform } from "./Platform";
import type { FailureObservationSummary } from "./FailureObservation";
import type { ExecutePlanDebugInfo } from "./ExecutePlanResult";

export interface PlanStep {
  tool: string;
  params: Record<string, any>;
  label?: string;
}

export interface PlanDeviceDefinition {
  label: string;
  platform: Platform;
  simulatorType?: string;
  iosVersion?: string;
}

export type PlanDevice = string | PlanDeviceDefinition;

export interface Plan {
  name: string;
  description?: string;
  devices?: PlanDevice[];
  steps: PlanStep[];
  mcpVersion?: string;
  metadata?: {
    createdAt: string;
    version: string;
    experiments?: string[];
    treatments?: Record<string, string>;
    featureFlags?: Record<string, any>;
    generatedFromToolCalls?: boolean;
    [key: string]: any; // Allow additional metadata
  };
}

export interface PlanExecutionResult {
  success: boolean;
  executedSteps: number;
  totalSteps: number;
  failedStep?: {
    stepIndex: number;
    tool: string;
    error: string;
    device?: string; // Device label for multi-device plans
    /** Observe summary from the failing observe call, or a fresh observe after other tool failures */
    failureObservation?: FailureObservationSummary;
  };
  deviceMapping?: Record<string, string>; // Maps device labels to device IDs (e.g., {"A": "emulator-5554", "B": "emulator-5556"})
  perDeviceResults?: Map<string, DeviceExecutionResult>; // For multi-device plans
  /**
   * Per-step trace for single-device sequential plans (`debug.steps`, `tapDebug` on `tapOn`, etc.).
   * Omitted for multi-device parallel execution.
   */
  debug?: ExecutePlanDebugInfo;
}

export interface DeviceExecutionResult {
  device: string;
  success: boolean;
  executedSteps: number;
  totalSteps: number;
  executionTimeMs?: number;
  failedStep?: {
    stepIndex: number; // Index in plan
    trackIndex: number; // Index in device track
    tool: string;
    error: string;
    failureObservation?: FailureObservationSummary;
  };
}

export type AbortStrategy = "immediate" | "finish-current-step";
export const DEFAULT_ABORT_STRATEGY: AbortStrategy = "immediate";
