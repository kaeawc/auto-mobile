import contract from "../../../schemas/prototype-spec-contract.json";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

export type PrototypeDesign = "material" | "platform";
interface PrototypeDesignCoverageEntry {
  readonly ios: "native" | "material" | "neutral";
  readonly android: "material" | "neutral";
  readonly parts?: readonly string[];
}
export const prototypeDesignCoverage = contract.designCoverage as Readonly<
  Record<keyof typeof contract.definitions.node.variants, PrototypeDesignCoverageEntry>
>;

/** Omission retains the platform look without requiring a new renderer. */
export function effectiveDesign(spec: unknown): PrototypeDesign {
  return record(record(spec)?.theme)?.design === "material" ? "material" : "platform";
}

/** Authored paths, including component definitions and repeat templates, in tree order. */
export function designFallbackPaths(spec: unknown): string[] {
  if (record(record(spec)?.theme)?.design !== "platform") {
    return [];
  }
  const paths: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const type = node.type;
    if (
      typeof type === "string" &&
      Object.hasOwn(prototypeDesignCoverage, type) &&
      prototypeDesignCoverage[type as keyof typeof prototypeDesignCoverage].ios === "material"
    ) {
      paths.push(path);
    }
  });
  return paths;
}
