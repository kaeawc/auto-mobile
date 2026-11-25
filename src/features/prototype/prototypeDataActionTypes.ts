/**
 * The data action types (#12519), in their own module so the runtime budget check stays out of
 * `prototypeDataActions.ts`'s import closure and browser-safe (#16453).
 */
export const PROTOTYPE_DATA_ACTION_TYPES = [
  "setData",
  "appendData",
  "upsertData",
  "prependData",
  "removeData",
] as const;
