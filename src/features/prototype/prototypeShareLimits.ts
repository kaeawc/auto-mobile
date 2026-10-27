import contract from "../../../schemas/prototype-spec-contract.json";

/** Share contract limits, shared with the native validators and pure resolvers. */
export const {
  MAX_PROTOTYPE_SHARE_TEXT_BYTES,
  MAX_PROTOTYPE_SHARE_IMAGES,
  MAX_PROTOTYPE_SHARE_FILES,
} = contract.limits;
