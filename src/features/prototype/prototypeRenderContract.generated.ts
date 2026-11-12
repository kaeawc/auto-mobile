// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-render-contract.ts

export const prototypeRenderLimits = {
  MAX_PROTOTYPE_DATA_POINTER_LENGTH: 256,
  MAX_PROTOTYPE_LIST_ITEMS: 2000,
  MAX_PROTOTYPE_NODES: 2000,
  MAX_PROTOTYPE_SPEC_NODES: 10000,
  MAX_PROTOTYPE_STRING_KEYS: 512,
  MAX_PROTOTYPE_STRING_LENGTH: 2048,
  MAX_PROTOTYPE_STRING_LOCALES: 16,
  MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH: 16384,
} as const;

/** The largest literal `repeat.items` array. */
export const PROTOTYPE_REPEAT_ITEMS_MAX = 128;

/** The `/device/widthClass` medium and expanded breakpoints, in dp. */
export const PROTOTYPE_WIDTH_CLASS_BREAKPOINTS = [600, 840] as const;

export const prototypeContractPatternSources = {
  pathKey: "^[A-Za-z_][A-Za-z0-9_]*$(?![\\s\\S])",
  stateKey: "^[A-Za-z_][A-Za-z0-9_]{0,63}$(?![\\s\\S])",
  boundKey: "^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|(?=[^{]*\\{)(?:[A-Za-z0-9_]|\\{(?:route\\.[A-Za-z_][A-Za-z0-9_]*|index|(?!route\\.)[A-Za-z_][A-Za-z0-9_]{0,63}\\.[A-Za-z_][A-Za-z0-9_]{0,63})\\})+)$(?![\\s\\S])",
  color: "^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$(?![\\s\\S])",
  blankText: "^[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$(?![\\s\\S])",
  numberToken: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$(?![\\s\\S])",
  pointer: "^(?:/(?:[^~/]|~[01])*)+$(?![\\s\\S])",
  currencyCode: "^[A-Z]{3}$(?![\\s\\S])",
  formatLocale: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$(?![\\s\\S])",
  formatTimeZone: "^[A-Za-z_]+([/+-][A-Za-z0-9_+-]+)*$(?![\\s\\S])",
  stringKey: "^[A-Za-z_][A-Za-z0-9_.-]{0,63}$",
  localeTag: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$",
  uploadDisposition: "^[^\\u0000-\\u001F\\u007F-\\u009F\"]+$(?![\\s\\S])",
  uploadContentType: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+$(?![\\s\\S])",
  openUrl: "^(?:https?|mailto|tel|sms|geo|maps):[^\\u0000-\\u0020\\u007F-\\u009F]+$(?![\\s\\S])",
  reservedEmail: "^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\\.)*(?:example\\.test|example\\.com|[A-Za-z0-9-]+\\.invalid)$(?![\\s\\S])",
  mediaUrl: "^https?://[^\\u0000-\\u0020\\u007F-\\u009F]+$(?![\\s\\S])",
  decimalAmount: "^(?:0|[1-9][0-9]{0,8})(?:\\.[0-9]{1,2})?$(?![\\s\\S])",
  isoPeriod: "^P[1-9][0-9]{0,2}[DWMY]$(?![\\s\\S])",
  webViewUrl: "^https://[^\\u0000-\\u0020\\u007F-\\u009F]+$(?![\\s\\S])",
  webOrigin: "^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::(?!443(?![\\s\\S]))(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$(?![\\s\\S])",
} as const;

export const prototypeStringFields = [
  "text",
  "label",
  "placeholder",
  "headline",
  "title",
  "supportingText",
  "errorText",
  "supporting",
  "trailingText",
  "message",
  "semantics.label",
  "semantics.hint",
] as const;

export const prototypeStringOpaqueFields = [
  "context",
  "data",
  "state",
  "assets",
  "theme",
  "storage",
  "value",
  "repeat",
  "payload",
  "body",
  "headers",
  "query",
  "strings",
] as const;
