import { ElementBounds } from "./ElementBounds";

export interface KeyboardResult {
  success: boolean;
  open: boolean;
  method?: "escape" | "dismissKey" | "returnKey";
  message?: string;
  error?: string;
  /**
   * Typed failure reason: `keyboard_state_unknown` when a close could not be confirmed
   * because no hierarchy re-read after the close completed to show the keyboard gone.
   */
  reason?: "keyboard_state_unknown";
  bounds?: ElementBounds[];
}
