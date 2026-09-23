export const KEYBOARD_PROFILE_IDS = ["direct", "gboard", "samsung"] as const;
export type KeyboardProfileId = (typeof KEYBOARD_PROFILE_IDS)[number];
