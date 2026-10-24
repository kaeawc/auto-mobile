import type { ProgressCallback } from "./BaseVisualChange";
import type { Element, ObserveResult } from "../../models";
import type { FieldTypeDetection } from "./FieldTypeDetector";
import type { InputTextOptions } from "./InputText";
import type { Keyboard } from "./Keyboard";
import type { Timer } from "../../utils/SystemTimer";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import type { ActionCall, TapOnCall } from "./ActionCall";
import type { TapAtCoordinate } from "./TapAtCoordinate";

/**
 * Interface for TapOnElement dependency
 */
export interface TapOnElementLike {
  execute(
    options: {
      text?: string;
      elementId?: string;
      action: string;
      container?: { text?: string; elementId?: string };
    },
    call?: TapOnCall,
  ): Promise<{
    success: boolean;
    element?: Element;
    focusVerified?: boolean;
    observation?: ObserveResult;
    error?: string;
  }>;
}

/**
 * Interface for InputText dependency
 */
export interface InputTextLike {
  execute(
    text: string,
    options?: InputTextOptions,
    call?: ActionCall,
  ): Promise<{
    success: boolean;
    text: string;
    observation?: ObserveResult;
    error?: string;
    retryable?: boolean;
  }>;
}

/**
 * Interface for ClearText dependency
 */
export interface ClearTextLike {
  execute(
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    observation?: ObserveResult;
    error?: string;
    warnings?: string[];
    retryable?: boolean;
  }>;
}

/**
 * Interface for SwipeOn dependency
 */
export interface SwipeOnLike {
  execute(
    options: {
      direction: string;
      gestureType?: "scrollTowardsDirection";
      lookFor?: { text?: string; elementId?: string };
      scrollToFind?: boolean;
    },
    call?: ActionCall,
  ): Promise<{
    success: boolean;
    found?: boolean;
    element?: Element;
    observation?: ObserveResult;
    error?: string;
  }>;
}

/**
 * Dependencies that can be injected for testing
 */
export interface SetUIStateDependencies {
  keyboard?: Pick<Keyboard, "execute">;
  tapOnElement?: TapOnElementLike;
  tapAt?: Pick<TapAtCoordinate, "execute">;
  inputText?: InputTextLike;
  clearText?: ClearTextLike;
  swipeOn?: SwipeOnLike;
  observeScreen?: ObserveScreen;
  fieldTypeDetector?: FieldTypeDetection;
  timer?: Timer;
}
