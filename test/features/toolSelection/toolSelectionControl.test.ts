import { describe, expect, test } from "bun:test";
import { toolSelectionProfileUuidFromResponse } from "../../../src/features/toolSelection/toolSelectionControl";

function response(sessionUuid: string, scope?: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ sessionUuid, ...(scope === undefined ? {} : { scope }) }),
      },
    ],
  };
}

describe("toolSelectionProfileUuidFromResponse", () => {
  test("returns only a server-confirmed connection-profile UUID", () => {
    expect(toolSelectionProfileUuidFromResponse(response("profile-a", "connection-profile"))).toBe(
      "profile-a",
    );
    expect(
      toolSelectionProfileUuidFromResponse(response("device-a", "device-session")),
    ).toBeUndefined();
  });

  test("does not adopt responses from daemons without a recognized scope", () => {
    expect(toolSelectionProfileUuidFromResponse(response("profile-a"))).toBeUndefined();
    expect(toolSelectionProfileUuidFromResponse(response("profile-a", "unknown"))).toBeUndefined();
  });
});
