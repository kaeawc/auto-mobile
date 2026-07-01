import { BaseActionResult } from "./BaseActionResult";

export interface PinchResult extends BaseActionResult {
  startingMagnitude: number;
  endingMagnitude: number;
  duration: number;
}
