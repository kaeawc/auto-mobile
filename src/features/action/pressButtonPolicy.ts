const NAVIGATION_PRESS_BUTTONS = new Set(["back", "home", "recent", "power"]);
const IN_PLACE_PRESS_BUTTONS = new Set(["menu", "volume_up", "volume_down"]);

export function isNavigationPressButton(button: unknown): boolean {
  return typeof button === "string" && NAVIGATION_PRESS_BUTTONS.has(button.toLowerCase());
}

export function isInPlacePressButton(button: unknown): boolean {
  return typeof button === "string" && IN_PLACE_PRESS_BUTTONS.has(button.toLowerCase());
}
