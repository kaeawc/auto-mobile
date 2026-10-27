/**
 * OEM persona catalog (#14055): named bundles of the facet executors that
 * approximate an OEM device on a stock Android emulator or device, modeled on
 * the CtrlProxy `KeyboardProfile` (id + version + evidence status). A persona
 * simulates what an app observes; it does not reproduce the OEM firmware.
 */
import type { KeyboardProfileId } from "../action/keyboardProfiles";
import type { DisplayProfileInput } from "./DisplayProfile";
import { KILL_PROFILE_NON_EMULATABLE, KILL_PROFILES, type KillProfileId } from "./KillProfiles";
import {
  MANUFACTURER_PROFILE_IDS,
  NON_EMULATABLE_CAPABILITY_IDS,
  type ManufacturerProfileId,
  type NonEmulatableCapability,
} from "../../models/ManufacturerProfileIds";

/** Increment when the catalog response shape or its shared semantics change. */
export const OEM_PERSONA_CATALOG_VERSION = 1;

/** How well a facet is grounded, from strongest to weakest. */
export const PERSONA_EVIDENCE_STATUSES = [
  "focused_trace",
  "vendor_documented",
  "cdd_derived",
  "inferred",
  "experimental",
] as const;

export type PersonaEvidenceStatus = (typeof PERSONA_EVIDENCE_STATUSES)[number];

export interface PersonaEvidence {
  status: PersonaEvidenceStatus;
  note: string;
  source?: string;
}

/** The facets a persona composes, each backed by an existing executor. */
export const PERSONA_FACETS = ["keyboard", "kill", "display"] as const;

export type PersonaFacet = (typeof PERSONA_FACETS)[number];

/**
 * The ICSME 2024 split (arXiv 2408.01810): "Functionality Break" facets change
 * how stock behaviour reaches the app (typing, background kills, display);
 * "OEM Feature" facets add vendor intents and settings screens. Every facet
 * today is a functionality break; vendor alias packs (#14056) are OEM features.
 */
export type PersonaFacetCategory = "functionalityBreak" | "oemFeature";

export const PERSONA_FACET_CATEGORIES: Readonly<Record<PersonaFacet, PersonaFacetCategory>> = {
  keyboard: "functionalityBreak",
  kill: "functionalityBreak",
  display: "functionalityBreak",
};

/** The note `killProfile list` reports for a behaviour no kill profile can reproduce. */
function killProfileNonEmulatableNote(id: string): string {
  return KILL_PROFILE_NON_EMULATABLE.find((entry) => entry.id === id)?.note ?? id;
}

/** OEM capabilities no stock device can provide; a task that needs one belongs on real hardware. */
export const NON_EMULATABLE_CAPABILITIES = {
  "samsung-dex": "Samsung DeX desktop mode.",
  knox: "Samsung Knox attestation, containers and enterprise APIs.",
  "flip-cover-screen": "The Galaxy Z Flip cover screen and its launcher.",
  "spen-air-actions": "S Pen Air actions and the S Pen remote.",
  "oem-systemui":
    "The OEM's own SystemUI (status bar, quick settings, recents); runtime resource overlays cannot overlay code.",
  "oem-unused-app-triggers": killProfileNonEmulatableNote("oem-unused-app-triggers"),
  "firmware-update-exemption-reset": killProfileNonEmulatableNote(
    "firmware-update-exemption-reset",
  ),
  "xiaomi-proprietary-appops": killProfileNonEmulatableNote("xiaomi-proprietary-appops"),
} as const satisfies Record<NonEmulatableCapability, string>;

export { NON_EMULATABLE_CAPABILITY_IDS, type NonEmulatableCapability };

export const OEM_PERSONA_IDS = MANUFACTURER_PROFILE_IDS;

export type OemPersonaId = ManufacturerProfileId;

export interface OemPersona {
  id: OemPersonaId;
  /** Bumped whenever a facet's value changes, so a result names the persona it applied. */
  version: number;
  displayName: string;
  keyboardProfileId: KeyboardProfileId;
  killProfile?: KillProfileId;
  displayProfile?: DisplayProfileInput;
  nonEmulatable: readonly NonEmulatableCapability[];
  /** One entry per facet the persona sets. */
  evidence: Readonly<Partial<Record<PersonaFacet, PersonaEvidence>>>;
}

const DONT_KILL_MY_APP = "https://dontkillmyapp.com/";

const GBOARD_TRACE_NOTE =
  "The gboard profile matches InputConnection traces captured from real Gboard on API 36; " +
  "autocorrect and prediction are not claimed.";

function gboardDefault(vendor: string): PersonaEvidence {
  return {
    status: "inferred",
    note: `${vendor} global builds ship Gboard as the default keyboard. ${GBOARD_TRACE_NOTE}`,
  };
}

/** The kill facet's evidence is the kill profile's own. */
function killEvidence(id: KillProfileId): PersonaEvidence {
  const profile = KILL_PROFILES[id];
  return {
    status: profile.evidenceStatus,
    note: profile.evidenceNote,
    ...(profile.source ? { source: profile.source } : {}),
  };
}

const PUNCH_HOLE: PersonaEvidence = {
  status: "inferred",
  note:
    "Current flagship and mid-range phones use a centred punch-hole camera; approximated with the " +
    "AOSP hole cutout overlay. The OEM's own SystemUI is not reproduced.",
};

export const OEM_PERSONAS: Readonly<Record<OemPersonaId, OemPersona>> = {
  "pixel-baseline": {
    id: "pixel-baseline",
    version: 1,
    displayName: "Pixel (stock baseline)",
    keyboardProfileId: "gboard",
    nonEmulatable: [],
    evidence: {
      keyboard: { status: "focused_trace", note: GBOARD_TRACE_NOTE },
    },
  },
  "samsung-oneui": {
    id: "samsung-oneui",
    version: 1,
    displayName: "Samsung One UI",
    keyboardProfileId: "samsung",
    killProfile: "samsung-sleeping",
    displayProfile: { cutout: "hole", navigationMode: "threebutton" },
    nonEmulatable: [
      "samsung-dex",
      "knox",
      "flip-cover-screen",
      "spen-air-actions",
      "oem-systemui",
      "oem-unused-app-triggers",
    ],
    evidence: {
      keyboard: {
        status: "experimental",
        note: "The samsung profile is an AutoMobile behaviour model; a Samsung Keyboard trace is pending.",
      },
      kill: killEvidence("samsung-sleeping"),
      display: {
        status: "inferred",
        note:
          "Many One UI releases ship the three-button navigation bar by default and current Galaxy S " +
          "phones use a centred punch-hole (defaults vary by model and One UI version); approximated " +
          "with the AOSP overlays. One UI SystemUI is not reproduced.",
      },
    },
  },
  "xiaomi-hyperos": {
    id: "xiaomi-hyperos",
    version: 1,
    displayName: "Xiaomi HyperOS",
    keyboardProfileId: "gboard",
    killProfile: "xiaomi-autostart-off",
    displayProfile: { cutout: "hole" },
    nonEmulatable: ["xiaomi-proprietary-appops", "oem-systemui", "firmware-update-exemption-reset"],
    evidence: {
      keyboard: gboardDefault("Xiaomi"),
      kill: killEvidence("xiaomi-autostart-off"),
      display: PUNCH_HOLE,
    },
  },
  "oneplus-oxygenos": {
    id: "oneplus-oxygenos",
    version: 1,
    displayName: "OnePlus OxygenOS",
    keyboardProfileId: "gboard",
    killProfile: "oneplus-deep-optimization",
    displayProfile: { cutout: "hole" },
    nonEmulatable: ["oem-systemui"],
    evidence: {
      keyboard: gboardDefault("OnePlus"),
      kill: killEvidence("oneplus-deep-optimization"),
      display: PUNCH_HOLE,
    },
  },
  "oppo-coloros": {
    id: "oppo-coloros",
    version: 1,
    displayName: "OPPO ColorOS",
    keyboardProfileId: "gboard",
    killProfile: "recents-swipe-force-stop",
    displayProfile: { cutout: "hole" },
    nonEmulatable: ["oem-systemui"],
    evidence: {
      keyboard: gboardDefault("OPPO"),
      kill: {
        ...killEvidence("recents-swipe-force-stop"),
        note: `ColorOS is reported to force-stop apps swiped from recents. ${KILL_PROFILES["recents-swipe-force-stop"].evidenceNote}`,
        source: DONT_KILL_MY_APP,
      },
      display: PUNCH_HOLE,
    },
  },
  motorola: {
    id: "motorola",
    version: 1,
    displayName: "Motorola",
    keyboardProfileId: "gboard",
    killProfile: "motorola-adaptive",
    nonEmulatable: [],
    evidence: {
      keyboard: gboardDefault("Motorola"),
      kill: killEvidence("motorola-adaptive"),
    },
  },
};

/** The facets `persona` sets, in the order apply runs them (reset runs them in reverse). */
export function personaFacets(persona: OemPersona): PersonaFacet[] {
  return [
    "keyboard",
    ...(persona.killProfile ? (["kill"] as const) : []),
    ...(persona.displayProfile ? (["display"] as const) : []),
  ];
}
