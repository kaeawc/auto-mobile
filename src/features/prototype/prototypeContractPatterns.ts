import contract from "../../../schemas/prototype-spec-contract.json";

/** Compile once; no flags or platform whitespace classes may widen the shared vocabulary. */
export const prototypeContractPatterns = Object.fromEntries(
  Object.entries(contract.patterns).map(([name, source]) => [name, new RegExp(source)]),
) as { [Name in keyof typeof contract.patterns]: RegExp };
