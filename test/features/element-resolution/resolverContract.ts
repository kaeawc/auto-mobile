import type { Element } from "../../../src/models/Element";
import {
  ElementResolver,
  type ResolutionAction,
} from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type {
  ContractCase,
  ContractCapture,
  ContractQuery,
  ContractResolution,
  ContractResolver,
} from "./observeContract";

const searchable = new SearchableHierarchy();
const resolver = new ElementResolver(() => 0);

/** Exercise the row's advertised action; an index is passed through unchanged. */
export function contractAction(testCase: ContractCase): ResolutionAction {
  const { affordances } = testCase.observed;
  if (affordances.includes("input")) return "input";
  if (affordances.includes("tap") || affordances.includes("toggle")) return "tap";
  if (affordances.includes("scroll")) return "scroll";
  if (affordances.includes("long-press")) return "long-press";
  return "inspect";
}

export class ResolverContractAdapter implements ContractResolver {
  constructor(private readonly testCase: ContractCase) {}

  resolve(capture: ContractCapture, query: ContractQuery): ContractResolution {
    const result = resolver.resolve(
      { id: capture.name, nodes: searchable.project(capture.hierarchy) },
      { [query.kind]: query.value, index: query.index, match: "exact" },
      { action: contractAction(this.testCase) },
    );
    if (result.error) throw new Error(result.error);
    const toElement = (node: (typeof result.candidates)[number]): Element => {
      if (!node.element)
        throw new Error(`Unbounded candidate in actionable fixture ${this.testCase.key}`);
      return node.element;
    };
    return {
      candidates: result.candidates.map(toElement),
      chosen: result.chosen ? toElement(result.chosen) : null,
    };
  }
}

export interface CandidateIdentity {
  elementId?: string;
  bounds: string;
}
export function candidateIdentity(element: Element): CandidateIdentity {
  const { left, top, right, bottom } = element.bounds;
  return {
    elementId: element["resource-id"] || element["view-id"],
    bounds: [left, top, right, bottom].join(","),
  };
}

/** Independent oracle: the IDs and bounds actually advertised by observe, in display order. */
export function observedCandidates(
  testCase: ContractCase,
  allCases: ContractCase[],
): CandidateIdentity[] {
  const peers = allCases.filter(
    ({ capture, query }) =>
      capture === testCase.capture &&
      query.kind === testCase.query.kind &&
      query.value === testCase.query.value,
  );
  const unique = new Map<string, CandidateIdentity>();
  for (const { observed } of peers) {
    const identity = { elementId: observed.elementId, bounds: observed.bounds.join(",") };
    unique.set(JSON.stringify(identity), identity);
  }
  const candidates = [...unique.values()];
  // B1: both recorded text-input captures also contain the keyboard's Settings
  // button. It is intentionally summarized as <ime> by observe, not a skeleton
  // row. Pin its actual captured identity instead of allowing arbitrary extras.
  if (
    ["diff/text-input-empty.json", "diff/text-input-typed.json"].includes(testCase.capture.name) &&
    testCase.query.kind === "text" &&
    testCase.query.value === "Settings"
  ) {
    candidates.push({
      elementId: "f97bfc80-0c82-fbcc-3947-7df34f5e57f4",
      bounds: "620,1517,780,1633",
    });
  }
  return candidates;
}
