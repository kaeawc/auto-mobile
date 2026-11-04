import { prototypeContractPatternSources } from "./prototypeRenderContract.generated";

/** Compile once; no flags or platform whitespace classes may widen the shared vocabulary. */
export const prototypeContractPatterns = Object.fromEntries(
  Object.entries(prototypeContractPatternSources).map(([name, source]) => [
    name,
    new RegExp(source),
  ]),
) as { [Name in keyof typeof prototypeContractPatternSources]: RegExp };
