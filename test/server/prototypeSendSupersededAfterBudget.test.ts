import { describe, expect, test } from "bun:test";
import type { PrototypeTransport } from "../../src/features/prototype/PrototypeTransport";
import { sendPrototype } from "../../src/server/prototypeTools/assets";
import type { PrototypeTarget } from "../../src/server/prototypeTools/types";

describe("sendPrototype with a beforeSend that finds the show superseded (#18804)", () => {
  test("sends nothing and reports the superseded outcome", async () => {
    const shown: string[] = [];
    const unused = async (): Promise<never> => {
      throw new Error("not used");
    };
    const transport: PrototypeTransport = {
      show: async () => {
        shown.push("show");
        return { success: true };
      },
      dismiss: unused,
      patch: unused,
      putAsset: unused,
      removeAsset: unused,
      status: unused,
      onEvent: () => () => {},
    };
    const target: PrototypeTarget = { transport };
    const outcome = await sendPrototype(
      target,
      { action: "show", spec: { id: "feed" } } as Parameters<typeof sendPrototype>[1],
      { uploaded: [], prepared: [] },
      { signal: undefined, displayId: undefined, beforeSend: async () => "superseded" },
    );
    expect(shown).toEqual([]);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error).toContain("newer show of the same id");
  });
});
