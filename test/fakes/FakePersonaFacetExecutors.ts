import type {
  PersonaDisplayExecutor,
  PersonaFacetExecutors,
  PersonaKeyboardExecutor,
  PersonaKillExecutor,
} from "../../src/features/utility/ApplyPersona";
import type {
  ApplyKillProfileResult,
  ResetKillProfileResult,
} from "../../src/features/utility/ApplyKillProfile";
import type { DisplayProfileResult } from "../../src/features/utility/DisplayProfile";
import { KILL_PROFILES } from "../../src/features/utility/KillProfiles";

export type FakeFacetCall =
  | { facet: "keyboard"; action: "set"; profile: string; owner?: string }
  | { facet: "keyboard"; action: "reset"; profile?: string }
  | { facet: "kill"; action: "apply"; appId: string; profile: string; owner?: string }
  | { facet: "kill"; action: "reset"; appId: string; owner?: string }
  | { facet: "display"; action: "apply"; input: object; owner?: string }
  | { facet: "display"; action: "reset"; owner?: string };

/** Facet executors that record each call and answer with a scripted outcome. */
export class FakePersonaFacetExecutors implements PersonaFacetExecutors {
  readonly calls: FakeFacetCall[] = [];
  /** The profile the fake keyboard reports as active before each set. */
  activeKeyboardProfile = "gboard";
  /** The fake keyboard record: the profile active before the first set, until reset. */
  keyboardBefore?: string;
  keyboardError?: Error;
  killError?: Error;
  displayError?: Error;
  killStatus: ApplyKillProfileResult["status"] = "applied";
  /** Packages the fake kill record still holds a change for. */
  readonly killPending = new Set<string>();
  displayStatus: DisplayProfileResult["status"] = "applied";

  readonly keyboard: PersonaKeyboardExecutor = {
    set: async (profile, owner) => {
      this.calls.push({ facet: "keyboard", action: "set", profile, owner });
      if (this.keyboardError) {
        throw this.keyboardError;
      }
      const previousProfileId = this.activeKeyboardProfile;
      this.keyboardBefore ??= previousProfileId;
      this.activeKeyboardProfile = profile;
      return { previousProfileId };
    },
    pending: () => this.keyboardBefore,
    reset: async () => {
      const profile = this.keyboardBefore;
      this.calls.push({ facet: "keyboard", action: "reset", profile });
      if (this.keyboardError) {
        throw this.keyboardError;
      }
      if (profile !== undefined) {
        this.activeKeyboardProfile = profile;
        this.keyboardBefore = undefined;
      }
    },
  };

  readonly kill: PersonaKillExecutor = {
    apply: async (appId, profile, owner) => {
      this.calls.push({ facet: "kill", action: "apply", appId, profile, owner });
      if (this.killError) {
        throw this.killError;
      }
      this.killPending.add(appId);
      const { id, version, evidenceStatus, evidenceNote, source } = KILL_PROFILES[profile];
      return {
        message: `applied ${profile}`,
        deviceId: "emulator-5554",
        appId,
        action: "apply",
        profile: { id, version, evidenceStatus, evidenceNote, source },
        status: this.killStatus,
        steps: [{ step: "kill", command: "shell am force-stop", status: "applied" }],
      };
    },
    hasPending: (appId) => this.killPending.has(appId),
    reset: async (appId, owner): Promise<ResetKillProfileResult> => {
      this.calls.push({ facet: "kill", action: "reset", appId, owner });
      if (this.killError) {
        throw this.killError;
      }
      this.killPending.delete(appId);
      return {
        message: `reset ${appId}`,
        deviceId: "emulator-5554",
        appId,
        action: "reset",
        source: "recorded",
        status: "applied",
        steps: [],
      };
    },
  };

  readonly display: PersonaDisplayExecutor = {
    apply: async (input, owner) => {
      this.calls.push({ facet: "display", action: "apply", input, owner });
      if (this.displayError) {
        throw this.displayError;
      }
      return {
        message: "applied display",
        deviceId: "emulator-5554",
        action: "apply",
        status: this.displayStatus,
        steps: [
          {
            step: "cutout",
            status: this.displayStatus === "unsupported" ? "unsupported" : "applied",
          },
        ],
      };
    },
    reset: async (owner) => {
      this.calls.push({ facet: "display", action: "reset", owner });
      if (this.displayError) {
        throw this.displayError;
      }
      return {
        message: "reset display",
        deviceId: "emulator-5554",
        action: "reset",
        status: "applied",
        steps: [],
      };
    },
  };
}
