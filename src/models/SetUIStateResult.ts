import { BaseActionResult } from "./BaseActionResult";
import { ElementSelector } from "./SetUIStateOptions";

/**
 * Detected field type for a UI element
 */
export type FieldType = "text" | "checkbox" | "toggle" | "dropdown" | "unknown";

/**
 * Result for a single field operation
 */
export interface FieldResult {
  /** Selector used to find the field */
  selector: ElementSelector;
  /** Whether the field was set successfully */
  success: boolean;
  /** Number of attempts made */
  attempts: number;
  /** Whether the value was verified after setting */
  verified?: boolean;
  /** Error message if the operation failed */
  error?: string;
  /** Detected field type */
  fieldType?: FieldType;
  /** Whether the field was skipped because it already had the correct value */
  skipped?: boolean;
  /**
   * True when this field was never reached because the overall call's
   * internal result deadline (issue #6222 reopen) was hit before processing
   * got to it -- distinct from `error` describing an attempted-and-failed
   * field. Lets a client tell "not attempted, safe to retry" apart from
   * "attempted and failed" without parsing `error` text.
   */
  notAttempted?: boolean;
}

/**
 * Result of the setUIState operation
 */
export interface SetUIStateResult extends BaseActionResult {
  /** Results for each field */
  fields: FieldResult[];
  /** Total attempts across all fields */
  totalAttempts: number;
}
