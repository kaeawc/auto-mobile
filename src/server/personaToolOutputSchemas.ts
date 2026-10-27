import { z } from "zod/v4";
import {
  NON_EMULATABLE_CAPABILITY_IDS,
  OEM_PERSONA_IDS,
  PERSONA_EVIDENCE_STATUSES,
  PERSONA_FACETS,
} from "../features/utility/OemPersonas";

const evidenceSchema = z
  .object({
    status: z.enum(PERSONA_EVIDENCE_STATUSES),
    note: z.string(),
    source: z.string().optional(),
  })
  .passthrough();

const personaSummarySchema = z
  .object({ id: z.enum(OEM_PERSONA_IDS), version: z.number(), displayName: z.string() })
  .passthrough();

const capabilitySchema = z
  .object({ id: z.enum(NON_EMULATABLE_CAPABILITY_IDS), note: z.string() })
  .passthrough();

const facetSchema = z
  .object({
    facet: z.enum(PERSONA_FACETS),
    category: z.enum(["functionalityBreak", "oemFeature"]).optional(),
    status: z.enum(["applied", "partial", "unsupported", "failed"]).optional(),
    evidence: evidenceSchema.optional(),
    value: z.unknown().optional(),
    detail: z.string().optional(),
  })
  .passthrough();

/**
 * Failures that changed nothing throw. A task needing an OEM capability no
 * manufacturer profile can emulate returns `success: false` with `status: route_to_real_device`.
 */
export const personaResultSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    action: z.enum(["list", "describe", "apply", "reset"]),
    deviceId: z.string(),
    catalogVersion: z.number().optional(),
    status: z.enum(["applied", "partial", "unsupported", "route_to_real_device"]).optional(),
    manufacturerProfile: personaSummarySchema.optional(),
    manufacturerProfileId: z.enum(OEM_PERSONA_IDS).optional(),
    replaced: z.enum(OEM_PERSONA_IDS).optional(),
    manufacturerProfiles: z.array(personaSummarySchema).optional(),
    evidenceStatuses: z.array(z.enum(PERSONA_EVIDENCE_STATUSES)).optional(),
    facets: z.array(facetSchema).optional(),
    nonEmulatable: z.array(capabilitySchema).optional(),
    capabilities: z.array(capabilitySchema).optional(),
  })
  .passthrough();
