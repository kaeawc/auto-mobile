/**
 * The perturbation matrix for the persona robustness harness (#14061): which device changes a
 * replay runs under, and the tool calls that apply them. Every perturbation is undone with one
 * `manufacturerProfile reset`, which also restores direct `displayProfile`, `keyboard setProfile`
 * and `killProfile` changes.
 */
import {
  OEM_PERSONA_IDS,
  OEM_PERSONAS,
  personaFacets,
  type OemPersona,
  type OemPersonaId,
} from "../../src/features/utility/OemPersonas";
import type { DisplayProfileInput } from "../../src/features/utility/DisplayProfile";
import type { DriveStep } from "../mcp-drive";

export type PerturbationKind = "baseline" | "persona" | "display" | "facet";

export interface Perturbation {
  id: string;
  kind: PerturbationKind;
  description: string;
  /** Tool calls that apply the perturbation, in order. */
  apply: DriveStep[];
  /** Human-readable facet changes, so a report names what the replay ran under. */
  facets: string[];
  /** For a facet ablation, the persona it was split from. */
  parentId?: string;
}

/** The stock baseline every other perturbation is compared against. */
export const BASELINE_PERSONA_ID: OemPersonaId = "pixel-baseline";

/** Display stressors from the issue's display-profile axis that run on any phone AVD. */
export const DISPLAY_STRESSORS: Readonly<Record<string, DisplayProfileInput>> = {
  "font-scale-1.3": { fontScale: 1.3 },
  "density-larger": { density: "larger" },
  "force-dark": { forceDark: true },
  "cutout-tall": { cutout: "tall" },
};

export const DISPLAY_STRESSOR_IDS = Object.keys(DISPLAY_STRESSORS);

export function resetStep(appId: string): DriveStep {
  return { tool: "manufacturerProfile", args: { action: "reset", appId } };
}

function describeDisplay(input: DisplayProfileInput): string {
  return Object.entries(input)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",");
}

function personaFacetLabels(persona: OemPersona): string[] {
  return personaFacets(persona).map((facet) => {
    if (facet === "keyboard") {
      return `keyboard:${persona.keyboardProfileId}`;
    }
    if (facet === "kill") {
      return `kill:${persona.killProfile}`;
    }
    return `display:${describeDisplay(persona.displayProfile ?? {})}`;
  });
}

export function personaPerturbation(id: OemPersonaId, appId: string): Perturbation {
  const persona = OEM_PERSONAS[id];
  return {
    id,
    kind: id === BASELINE_PERSONA_ID ? "baseline" : "persona",
    description: `${persona.displayName} v${persona.version}`,
    apply: [
      { tool: "manufacturerProfile", args: { action: "apply", manufacturerProfile: id, appId } },
    ],
    facets: personaFacetLabels(persona),
  };
}

export function displayPerturbation(id: string): Perturbation {
  const input = DISPLAY_STRESSORS[id];
  if (!input) {
    throw new Error(`Unknown display stressor '${id}'; known: ${DISPLAY_STRESSOR_IDS.join(", ")}.`);
  }
  return {
    id: `display:${id}`,
    kind: "display",
    description: `Display stressor ${id}`,
    apply: [{ tool: "displayProfile", args: { action: "apply", ...input } }],
    facets: [`display:${describeDisplay(input)}`],
  };
}

/**
 * Split a persona into one perturbation per facet it changes from the baseline, so a failure can
 * be traced to the facet that reproduces it alone. A facet equal to the baseline's is skipped:
 * the baseline already ran it.
 */
export function facetAblations(id: OemPersonaId, appId: string): Perturbation[] {
  const persona = OEM_PERSONAS[id];
  const baseline = OEM_PERSONAS[BASELINE_PERSONA_ID];
  const labels = personaFacetLabels(persona);
  return personaFacets(persona).flatMap((facet, index): Perturbation[] => {
    const label = labels[index]!;
    const base = { id: `${id}/${label}`, kind: "facet" as const, facets: [label], parentId: id };
    if (facet === "keyboard") {
      if (persona.keyboardProfileId === baseline.keyboardProfileId) {
        return [];
      }
      const args = { action: "setProfile", profile: persona.keyboardProfileId };
      return [
        {
          ...base,
          description: `${persona.displayName} keyboard only`,
          apply: [{ tool: "keyboard", args }],
        },
      ];
    }
    if (facet === "kill") {
      const args = { action: "apply", appId, profile: persona.killProfile };
      return [
        {
          ...base,
          description: `${persona.displayName} kill only`,
          apply: [{ tool: "killProfile", args }],
        },
      ];
    }
    const args = { action: "apply", ...persona.displayProfile };
    return [
      {
        ...base,
        description: `${persona.displayName} display only`,
        apply: [{ tool: "displayProfile", args }],
      },
    ];
  });
}

/**
 * Resolve the `--personas` selection: OEM persona ids and `display:<stressor>` ids. Empty selects
 * every non-baseline persona and every display stressor. The baseline always runs, so it is
 * never part of the returned list.
 */
export function selectPerturbations(selection: string[], appId: string): Perturbation[] {
  const ids =
    selection.length > 0
      ? selection
      : [
          ...OEM_PERSONA_IDS.filter((id) => id !== BASELINE_PERSONA_ID),
          ...DISPLAY_STRESSOR_IDS.map((id) => `display:${id}`),
        ];
  return ids
    .filter((id) => id !== BASELINE_PERSONA_ID)
    .map((id) => {
      if (id.startsWith("display:")) {
        return displayPerturbation(id.slice("display:".length));
      }
      if (isOemPersonaId(id)) {
        return personaPerturbation(id, appId);
      }
      throw new Error(
        `Unknown perturbation '${id}'; use a manufacturer profile id ` +
          `(${OEM_PERSONA_IDS.join(", ")}) or display:<${DISPLAY_STRESSOR_IDS.join("|")}>.`,
      );
    });
}

export function isOemPersonaId(id: string): id is OemPersonaId {
  return (OEM_PERSONA_IDS as readonly string[]).includes(id);
}
