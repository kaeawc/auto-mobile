import type { Element } from "../models";

/**
 * Debug information about an element search failure
 */
export interface ElementSearchDebugInfo {
  /**
   * What was being searched for
   */
  searchCriteria: {
    text?: string;
    resourceId?: string;
    container?: {
      elementId?: string;
      text?: string;
    };
  };

  /**
   * Elements that were close matches but didn't match exactly
   */
  nearMisses?: Array<{
    element: Element;
    property: string;
    value: string;
    reason: string;
  }>;

  /**
   * Total number of elements checked
   */
  totalElementsChecked?: number;

  /**
   * Current device state
   */
  deviceState?: {
    currentActivity?: string;
    focusedWindow?: string;
  };
}

/**
 * Generic debug information that can be included in any tool result
 */
export interface ToolDebugInfo {
  /**
   * Execution time in milliseconds
   */
  executionTimeMs?: number;

  /**
   * Element search debug info (for tools that search for elements)
   */
  elementSearch?: ElementSearchDebugInfo;

  /**
   * Additional debug data (tool-specific)
   */
  [key: string]: any;
}
