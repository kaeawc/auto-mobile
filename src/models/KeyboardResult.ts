import { ElementBounds } from "./ElementBounds";

export interface KeyboardResult {
  success: boolean;
  open: boolean;
  method?: "escape" | "dismissKey" | "returnKey";
  message?: string;
  error?: string;
  bounds?: ElementBounds[];
}
