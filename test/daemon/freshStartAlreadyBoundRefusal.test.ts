import { describe, expect, test } from "bun:test";
import { freshStartAlreadyBoundError } from "../../src/daemon/deviceAcquisitionRefusals";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";

/** A freshly started device held by another session is the typed device_owned_by_other_session (#11351). */
describe("freshStartAlreadyBoundError", () => {
  for (const awaitingOwner of [false, true]) {
    test(`is typed on the wire (awaiting owner: ${awaitingOwner})`, () => {
      const error = freshStartAlreadyBoundError("emulator-5554", "holder", awaitingOwner);
      expect(error).toBeInstanceOf(InputDeviceOwnedError);
      const wire = JSON.parse(
        shapeToolCallError(error, { toolName: "startDevice", source: "MCP" }).content[0].text,
      );
      expect(wire).toMatchObject({
        code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
        deviceId: "emulator-5554",
        retryable: false,
      });
    });
  }

  test("keeps its long-standing wording", () => {
    expect(freshStartAlreadyBoundError("d", "s1", false).message).toBe(
      "Freshly started device 'd' was assigned to session s1 before its owning session could reserve it.",
    );
    expect(freshStartAlreadyBoundError("d", "s1", true).message).toContain(
      "restored after a restart and is holding for its previous owner",
    );
  });
});
