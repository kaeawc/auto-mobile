import type { Element } from "../../../src/models/Element";
import {
  ElementResolver,
  type ResolutionAction,
} from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { observedRows } from "./observeContract";
import type {
  ContractCase,
  ContractCapture,
  ContractQuery,
  ContractResolution,
  ContractResolver,
} from "./observeContract";
import type { ResolverSelector } from "../../../src/server/elementSelectorSchemas";

const searchable = new SearchableHierarchy();
const defaultResolver = new ElementResolver(() => 0.99);

function selectorFor(
  kind: ContractQuery["kind"],
  value: string,
  query?: ContractQuery,
): ResolverSelector {
  const field = kind === "elementId" ? "elementId" : kind === "testTag" ? "testTag" : "text";
  return {
    [field]: value,
    ...(query?.index === undefined ? {} : { index: query.index }),
    ...(query?.strategy === undefined ? {} : { selectionStrategy: query.strategy }),
    ...(query?.container
      ? {
          container: query.container.elementId
            ? { elementId: query.container.elementId }
            : { text: query.container.text },
        }
      : {}),
    match: "exact",
  };
}

/** Exercise the row's advertised action; an index is passed through unchanged. */
export function contractAction(testCase: ContractCase): ResolutionAction {
  const { affordances } = testCase.observed;
  if (affordances.includes("input")) {
    return "input";
  }
  if (affordances.includes("tap") || affordances.includes("toggle")) {
    return "tap";
  }
  if (affordances.includes("scroll")) {
    return "scroll";
  }
  if (affordances.includes("long-press")) {
    return "long-press";
  }
  return "inspect";
}

export class ResolverContractAdapter implements ContractResolver {
  private readonly resolver: ElementResolver;

  /** `random` overrides the default 0.99 draw used for "random" selection strategies. */
  constructor(
    private readonly testCase: ContractCase,
    random?: () => number,
  ) {
    this.resolver = random ? new ElementResolver(random) : defaultResolver;
  }

  resolve(capture: ContractCapture, query: ContractQuery): ContractResolution {
    const anchorValue = this.testCase.observed.elementId ?? this.testCase.observed.label;
    const selector = query.sibling
      ? {
          ...selectorFor(
            this.testCase.observed.elementId ? "elementId" : "text",
            anchorValue ?? query.value,
            query,
          ),
          sibling: selectorFor(query.kind, query.value),
        }
      : selectorFor(query.kind, query.value, query);
    const result = this.resolver.resolve(
      { id: capture.name, nodes: searchable.project(capture.hierarchy) },
      selector,
      { action: query.intent === "focus-input" ? "focus" : contractAction(this.testCase) },
    );
    if (result.error) {
      throw new Error(result.error);
    }
    const toElement = (node: (typeof result.candidates)[number]): Element => {
      if (!node.element) {
        throw new Error(`Unbounded candidate in actionable fixture ${this.testCase.key}`);
      }
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
  const query = testCase.query;
  if (query.strategy === "random" && !query.container && !query.sibling) {
    return observedRows(testCase.capture)
      .filter((row) =>
        query.kind === "elementId"
          ? row.elementId === query.value
          : query.kind === "testTag"
            ? row.testTag === query.value
            : row.label === query.value,
      )
      .sort(
        (a, b) =>
          (a.index ?? 0) - (b.index ?? 0) ||
          (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
            (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
      )
      .map((row) => ({ elementId: row.elementId, bounds: row.bounds.join(",") }));
  }
  const peers = allCases.filter(
    ({ capture, query }) =>
      capture === testCase.capture &&
      query.kind === testCase.query.kind &&
      query.value === testCase.query.value &&
      JSON.stringify(query.container) === JSON.stringify(testCase.query.container),
  );
  const unique = new Map<string, { identity: CandidateIdentity; index?: number }>();
  for (const { observed, query } of peers) {
    const identity = { elementId: observed.elementId, bounds: observed.bounds.join(",") };
    unique.set(JSON.stringify(identity), { identity, index: query.index });
  }
  const candidates = [...unique.values()]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(({ identity }) => identity);
  // B1: both recorded text-input captures also contain the keyboard's Settings
  // button. It is intentionally summarized as <ime> by observe, not a skeleton
  // row. Pin its actual captured identity instead of allowing arbitrary extras.
  if (
    ["diff/text-input-empty.json", "diff/text-input-typed.json"].includes(testCase.capture.name) &&
    testCase.query.kind === "text" &&
    testCase.query.value === "Settings"
  ) {
    candidates.unshift({
      elementId: "f97bfc80-0c82-fbcc-3947-7df34f5e57f4",
      bounds: "620,1517,780,1633",
    });
  }
  return candidates;
}
