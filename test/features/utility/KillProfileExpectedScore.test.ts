import { describe, expect, test } from "bun:test";
import {
  KILL_PROFILE_EXPECTED_SCORES,
  SURVIVAL_EVENT_IDS,
} from "../../../src/features/utility/KillProfileExpectedScores";
import { KILL_PROFILE_IDS, KILL_PROFILES } from "../../../src/features/utility/KillProfiles";

describe("kill profile expected survival scores", () => {
  test("every profile covers exactly every stable event id", () => {
    for (const id of KILL_PROFILE_IDS) {
      expect(Object.keys(KILL_PROFILE_EXPECTED_SCORES[id]).sort()).toEqual(
        [...SURVIVAL_EVENT_IDS].sort(),
      );
      for (const event of SURVIVAL_EVENT_IDS) {
        expect(["ran", "delayed", "never", "TODO_MEASURE"]).toContain(
          KILL_PROFILE_EXPECTED_SCORES[id][event],
        );
      }
    }
  });

  test("internal measurements do not change the public catalog JSON", () => {
    for (const id of KILL_PROFILE_IDS) {
      expect(JSON.stringify(KILL_PROFILES[id])).not.toContain("expectedScore");
      expect(KILL_PROFILE_EXPECTED_SCORES[id]).toBeDefined();
    }
  });

  test("no expected value is TODO_MEASURE", () => {
    for (const id of KILL_PROFILE_IDS) {
      for (const event of SURVIVAL_EVENT_IDS) {
        expect(KILL_PROFILE_EXPECTED_SCORES[id][event]).not.toBe("TODO_MEASURE");
      }
    }
  });
});
