import contract from "../../../schemas/prototype-spec-contract.json";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

export type PrototypeDesign = "material" | "platform";
interface PrototypeDesignCoverageEntry {
  readonly ios: "native" | "material" | "neutral";
  readonly android: "material" | "neutral";
  readonly parts?: readonly string[];
  readonly reason?: string;
}
export const prototypeDesignCoverage = contract.designCoverage as Readonly<
  Record<keyof typeof contract.definitions.node.variants, PrototypeDesignCoverageEntry>
>;

/** Omission retains the platform look without requiring a new renderer. */
export function effectiveDesign(spec: unknown): PrototypeDesign {
  return record(record(spec)?.theme)?.design === "material" ? "material" : "platform";
}

/** Authored paths, including component definitions and repeat templates, in tree order. */
export function designFallbackPaths(
  spec: unknown,
  supports: (capability: string) => boolean = () => true,
): string[] {
  if (effectiveDesign(spec) !== "platform") {
    return [];
  }
  const nativeNodes = new Set(prototypeNativeDesignNodes(supports));
  const paths: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const type = node.type;
    if (
      typeof type === "string" &&
      Object.hasOwn(prototypeDesignCoverage, type) &&
      (prototypeDesignCoverage[type as keyof typeof prototypeDesignCoverage].ios === "material" ||
        (prototypeDesignCoverage[type as keyof typeof prototypeDesignCoverage].ios === "native" &&
          !nativeNodes.has(type)))
    ) {
      paths.push(path);
    }
  });
  return paths;
}

const legacyNativeNodes = new Set(["button", "slider", "datePicker", "timePicker", "pasteButton"]);

/** Per-control capabilities come from the connected iOS agent's OS-filtered advertisement. */
export function prototypeDesignNativeCapability(type: string): string {
  return `prototype_design_ios_${type}_v1`;
}

export function prototypeNativeDesignNodes(supports: (capability: string) => boolean): string[] {
  const hasPerTypeCoverage = Object.keys(prototypeDesignCoverage).some((type) =>
    supports(prototypeDesignNativeCapability(type)),
  );
  const legacy = supports("prototype_design_platform_v1") && !hasPerTypeCoverage;
  return Object.entries(prototypeDesignCoverage)
    .filter(
      ([type, entry]) =>
        entry.ios === "native" &&
        (supports(prototypeDesignNativeCapability(type)) ||
          (legacy && legacyNativeNodes.has(type))),
    )
    .map(([type]) => type)
    .sort();
}
