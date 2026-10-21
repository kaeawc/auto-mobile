import type { BootedDevice } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { throwIfAborted } from "../../utils/toolUtils";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { ApplyKillProfileResult, ResetKillProfileResult } from "./ApplyKillProfile";
import type { DisplayProfileInput, DisplayProfileResult } from "./DisplayProfile";
import type { KillProfileId } from "./KillProfiles";
import {
  NON_EMULATABLE_CAPABILITIES,
  OEM_PERSONA_CATALOG_VERSION,
  OEM_PERSONA_IDS,
  OEM_PERSONAS,
  PERSONA_EVIDENCE_STATUSES,
  PERSONA_FACET_CATEGORIES,
  personaFacets,
  type NonEmulatableCapability,
  type OemPersona,
  type OemPersonaId,
  type PersonaEvidence,
  type PersonaFacet,
  type PersonaFacetCategory,
} from "./OemPersonas";
import { defaultPersonaRestoreRegistry, type PersonaRestoreRegistry } from "./PersonaRestore";

/** Sets the AutoMobile IME's keyboard behaviour profile, as `keyboard setProfile`. */
export interface PersonaKeyboardExecutor {
  set(profile: string, signal?: AbortSignal): Promise<{ previousProfileId?: string }>;
}

/** `killProfile` apply and reset for one package. */
export interface PersonaKillExecutor {
  apply(appId: string, profile: KillProfileId, owner?: string): Promise<ApplyKillProfileResult>;
  reset(appId: string, owner?: string): Promise<ResetKillProfileResult>;
}

/** `displayProfile` apply and reset. */
export interface PersonaDisplayExecutor {
  apply(input: DisplayProfileInput, owner?: string): Promise<DisplayProfileResult>;
  reset(owner?: string): Promise<DisplayProfileResult>;
}

/** The existing facet executors a persona composes. */
export interface PersonaFacetExecutors {
  keyboard: PersonaKeyboardExecutor;
  kill: PersonaKillExecutor;
  display: PersonaDisplayExecutor;
}

export interface PersonaDependencies {
  executors: PersonaFacetExecutors;
  registry?: PersonaRestoreRegistry;
  /** The daemon session applying, whose release restores the kill and display facets. */
  owner?: string;
  signal?: AbortSignal;
}

export type PersonaFacetStatus = "applied" | "partial" | "unsupported" | "failed";

export interface PersonaFacetResult {
  facet: PersonaFacet;
  category: PersonaFacetCategory;
  status: PersonaFacetStatus;
  evidence: PersonaEvidence;
  /** What the facet's executor reported, or why it failed. */
  detail?: string;
}

/** `applied`: every facet applied; `partial`: some did, or did in part; `unsupported`: none could. */
export type PersonaOutcome = "applied" | "partial" | "unsupported";

type PersonaSummary = Pick<OemPersona, "id" | "version" | "displayName">;

export interface ApplyPersonaResult {
  message: string;
  deviceId: string;
  action: "apply";
  catalogVersion: number;
  persona: PersonaSummary;
  status: PersonaOutcome;
  facets: PersonaFacetResult[];
  nonEmulatable: { id: NonEmulatableCapability; note: string }[];
}

/** A task needs an OEM capability no persona can emulate: run it on real hardware instead. */
export interface RoutePersonaResult {
  message: string;
  deviceId: string;
  action: "apply";
  catalogVersion: number;
  persona: PersonaSummary;
  status: "route_to_real_device";
  capabilities: { id: NonEmulatableCapability; note: string }[];
}

export interface ResetPersonaResult {
  message: string;
  deviceId: string;
  action: "reset";
  /** The persona applied last, when one is recorded. */
  personaId?: OemPersonaId;
  status: "applied";
  facets: { facet: PersonaFacet; status: "applied"; detail?: string }[];
}

function summary(persona: OemPersona): PersonaSummary {
  return { id: persona.id, version: persona.version, displayName: persona.displayName };
}

function capabilityNotes(
  ids: readonly NonEmulatableCapability[],
): { id: NonEmulatableCapability; note: string }[] {
  return ids.map((id) => ({ id, note: NON_EMULATABLE_CAPABILITIES[id] }));
}

/** The facet's configured value: a keyboard or kill profile id, or the display fields. */
function facetValue(persona: OemPersona, facet: PersonaFacet): string | DisplayProfileInput {
  switch (facet) {
    case "keyboard":
      return persona.keyboardProfileId;
    case "kill":
      return persona.killProfile ?? "";
    case "display":
      return persona.displayProfile ?? {};
  }
}

function evidenceFor(persona: OemPersona, facet: PersonaFacet): PersonaEvidence {
  const evidence = persona.evidence[facet];
  if (!evidence) {
    throw new ActionableError(`Persona ${persona.id} has no evidence for its ${facet} facet.`);
  }
  return evidence;
}

export function listPersonas() {
  return {
    catalogVersion: OEM_PERSONA_CATALOG_VERSION,
    evidenceStatuses: [...PERSONA_EVIDENCE_STATUSES],
    personas: OEM_PERSONA_IDS.map((id) => {
      const persona = OEM_PERSONAS[id];
      return { ...summary(persona), facets: personaFacets(persona) };
    }),
  };
}

/** Every facet the persona sets, with its category and evidence, and what it cannot emulate. */
export function describePersona(id: OemPersonaId) {
  const persona = OEM_PERSONAS[id];
  return {
    catalogVersion: OEM_PERSONA_CATALOG_VERSION,
    persona: summary(persona),
    facets: personaFacets(persona).map((facet) => ({
      facet,
      category: PERSONA_FACET_CATEGORIES[facet],
      value: facetValue(persona, facet),
      evidence: evidenceFor(persona, facet),
    })),
    nonEmulatable: capabilityNotes(persona.nonEmulatable),
  };
}

interface ApplyContext {
  device: BootedDevice;
  persona: OemPersona;
  appId?: string;
  deps: PersonaDependencies;
  registry: PersonaRestoreRegistry;
}

/** Run one facet's executor and return its status and a one-line detail. */
async function runFacet(
  context: ApplyContext,
  facet: PersonaFacet,
): Promise<{ status: Exclude<PersonaFacetStatus, "failed">; detail?: string }> {
  const { device, persona, deps, registry } = context;
  throwIfAborted(deps.signal);
  switch (facet) {
    case "keyboard": {
      const result = await deps.executors.keyboard.set(persona.keyboardProfileId, deps.signal);
      registry.recordApply(device.deviceId, persona.id, {
        keyboardProfileBefore: result.previousProfileId,
      });
      return { status: "applied", detail: `keyboard profile ${persona.keyboardProfileId}` };
    }
    case "kill": {
      const appId = context.appId as string;
      const profile = persona.killProfile as KillProfileId;
      registry.recordApply(device.deviceId, persona.id, { killAppId: appId });
      const result = await deps.executors.kill.apply(appId, profile, deps.owner);
      return { status: result.status, detail: result.message };
    }
    case "display": {
      const result = await deps.executors.display.apply(
        persona.displayProfile as DisplayProfileInput,
        deps.owner,
      );
      return { status: result.status, detail: result.message };
    }
  }
}

function outcomeOf(facets: readonly PersonaFacetResult[]): PersonaOutcome {
  if (facets.every((facet) => facet.status === "applied")) {
    return "applied";
  }
  return facets.some((facet) => facet.status === "applied" || facet.status === "partial")
    ? "partial"
    : "unsupported";
}

function describeFacets(facets: readonly { facet: string; status: string }[]): string {
  return facets.map((facet) => `${facet.facet} ${facet.status}`).join(", ");
}

/**
 * Apply an OEM persona (#14055) by composing the existing facet executors: the
 * keyboard profile, then the kill profile for `appId`, then the display
 * profile. A failed facet does not stop the others. When `requires` names a
 * capability the persona cannot emulate, nothing changes and the result routes
 * the task to a real device instead of passing silently.
 */
export async function applyPersona(
  device: BootedDevice,
  personaId: OemPersonaId,
  options: { appId?: string; requires?: readonly NonEmulatableCapability[] },
  deps: PersonaDependencies,
): Promise<ApplyPersonaResult | RoutePersonaResult> {
  const persona = OEM_PERSONAS[personaId];
  const blocked = (options.requires ?? []).filter((id) => persona.nonEmulatable.includes(id));
  if (blocked.length > 0) {
    return {
      message: `${persona.displayName} cannot emulate ${blocked.join(", ")}; run this task on a real ${persona.displayName} device.`,
      deviceId: device.deviceId,
      action: "apply",
      catalogVersion: OEM_PERSONA_CATALOG_VERSION,
      persona: summary(persona),
      status: "route_to_real_device",
      capabilities: capabilityNotes(blocked),
    };
  }
  if (persona.killProfile && !options.appId) {
    throw new ActionableError(
      `persona ${persona.id} sets kill profile ${persona.killProfile}; apply needs appId.`,
    );
  }
  const context: ApplyContext = {
    device,
    persona,
    appId: options.appId,
    deps,
    registry: deps.registry ?? defaultPersonaRestoreRegistry,
  };
  const facets: PersonaFacetResult[] = [];
  for (const facet of personaFacets(persona)) {
    const base = {
      facet,
      category: PERSONA_FACET_CATEGORIES[facet],
      evidence: evidenceFor(persona, facet),
    };
    try {
      facets.push({ ...base, ...(await runFacet(context, facet)) });
    } catch (error) {
      logger.warn(`persona ${persona.id} ${facet} facet failed: ${errorMessage(error)}`, error);
      facets.push({
        ...base,
        status: "failed",
        detail: toActionableError(error, `${facet} facet failed`).message,
      });
    }
  }
  if (!facets.some((facet) => facet.status === "applied" || facet.status === "partial")) {
    throw new ActionableError(
      `persona ${persona.id} changed nothing on ${device.deviceId}: ${describeFacets(facets)}`,
    );
  }
  const status = outcomeOf(facets);
  return {
    message: `Applied persona ${persona.id} v${persona.version} to ${device.deviceId} (${status}): ${describeFacets(facets)}`,
    deviceId: device.deviceId,
    action: "apply",
    catalogVersion: OEM_PERSONA_CATALOG_VERSION,
    persona: summary(persona),
    status,
    facets,
    nonEmulatable: capabilityNotes(persona.nonEmulatable),
  };
}

/** Reset steps in reverse apply order: display, each recorded kill package, then keyboard. */
function resetSteps(
  device: BootedDevice,
  appId: string | undefined,
  deps: PersonaDependencies,
  registry: PersonaRestoreRegistry,
): { facet: PersonaFacet; run: () => Promise<string> }[] {
  const recorded = registry.get(device.deviceId);
  const appIds = [...new Set([...(recorded?.killAppIds ?? []), ...(appId ? [appId] : [])])];
  const keyboardBefore = recorded?.keyboardProfileBefore;
  return [
    {
      facet: "display",
      run: async () => (await deps.executors.display.reset(deps.owner)).message,
    },
    ...appIds.map((id) => ({
      facet: "kill" as const,
      run: async () => {
        const result = await deps.executors.kill.reset(id, deps.owner);
        registry.forgetKill(device.deviceId, id);
        return result.message;
      },
    })),
    ...(keyboardBefore !== undefined
      ? [
          {
            facet: "keyboard" as const,
            run: async () => {
              await deps.executors.keyboard.set(keyboardBefore, deps.signal);
              registry.forgetKeyboard(device.deviceId);
              return `keyboard profile ${keyboardBefore}`;
            },
          },
        ]
      : []),
  ];
}

/**
 * Restore what personas changed on the device (#14055): the display facets, the
 * kill facet of every package a persona applied to (plus `appId`), then the
 * keyboard profile recorded before the first persona. Every step runs; a step
 * the device refuses stays recorded and the reset is an error.
 */
export async function resetPersona(
  device: BootedDevice,
  options: { appId?: string },
  deps: PersonaDependencies,
): Promise<ResetPersonaResult> {
  const registry = deps.registry ?? defaultPersonaRestoreRegistry;
  const personaId = registry.get(device.deviceId)?.personaId;
  const facets: ResetPersonaResult["facets"] = [];
  const failures: string[] = [];
  for (const step of resetSteps(device, options.appId, deps, registry)) {
    throwIfAborted(deps.signal);
    try {
      facets.push({ facet: step.facet, status: "applied", detail: await step.run() });
    } catch (error) {
      logger.warn(`persona reset of ${step.facet} failed: ${errorMessage(error)}`, error);
      failures.push(`${step.facet}: ${errorMessage(error)}`);
    }
  }
  registry.clearIfRestored(device.deviceId);
  if (failures.length > 0) {
    throw new ActionableError(`persona reset on ${device.deviceId} failed: ${failures.join("; ")}`);
  }
  return {
    message: `Reset ${personaId ? `persona ${personaId}` : "personas"} on ${device.deviceId}: ${describeFacets(facets)}`,
    deviceId: device.deviceId,
    action: "reset",
    ...(personaId ? { personaId } : {}),
    status: "applied",
    facets,
  };
}
