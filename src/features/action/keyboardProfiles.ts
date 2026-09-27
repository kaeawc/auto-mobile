export const KEYBOARD_PROFILE_IDS = ["direct", "gboard", "samsung"] as const;
export type KeyboardProfileId = (typeof KEYBOARD_PROFILE_IDS)[number];

export const KEYBOARD_PROFILE_CATALOG_ID = "automobile_behavior_profiles" as const;
export const KEYBOARD_PROFILE_CATALOG_VERSIONS = [1] as const;

export interface KeyboardProfileBehavior {
  composeWords: boolean;
  enterStrategy: "KEY_EVENT" | "COMMIT_NEWLINE";
  backspaceStrategy: "DELETE_SURROUNDING" | "KEY_EVENT";
  recomposeOnCursorMove: boolean;
  recomposeOnBackspaceIntoWord: boolean;
  batchEdits: boolean;
}

export interface KeyboardProfileDescriptor {
  id: string;
  displayName: string;
  version: number;
  evidenceStatus: "baseline" | "focused_trace" | "experimental";
  evidenceNote: string;
  behavior: KeyboardProfileBehavior;
}

export interface KeyboardProfileCatalog {
  success: boolean;
  catalogId?: string;
  catalogVersion?: number;
  supportedCatalogVersions?: number[];
  activeProfileId?: string;
  profiles?: KeyboardProfileDescriptor[];
  error?: string;
}
