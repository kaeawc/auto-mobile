import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { observeToolScreen } from "../helpers/observeToolScreen";
import { describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../src/models";
import type { AudioInputDiagnostic } from "../../src/models/AudioInputDiagnostic";
import { registerObserveTools } from "../../src/server/observeTools";
import { observeResultSchema } from "../../src/server/toolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { readToolEnvelopePayload } from "../../src/utils/toolEnvelopePayload";
import type { AudioInputDiagnosticResolver } from "../../src/utils/audio/audioInputDiagnostic";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import toolDefinitions from "../../schemas/tool-definitions.json";
import { capturedTwoWindowHierarchy, observationOf } from "../helpers/prototypeWindowCapture";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const diagnostic: AudioInputDiagnostic = {
  code: "audio_input_unavailable",
  message:
    "The emulator is launched with -no-audio. Recordings on this device will contain no audio.",
  retryable: false,
};

async function observe(resolver: AudioInputDiagnosticResolver, result: ObserveResult) {
  const screen = new FakeObserveScreen();
  screen.setObserveResult(result);
  const seen: BootedDevice[] = [];
  try {
    registerObserveTools({
      hidesPrototypeForScreenshot: async () => false,
      createScreen: () => observeToolScreen(screen),
      audioInputDiagnostic: (target) => {
        seen.push(target);
        return resolver(target);
      },
    });
    const tool = ToolRegistry.getTool("observe")!;
    const response = await tool.deviceAwareHandler!(
      device,
      tool.schema.parse({ screenshot: "none" }),
    );
    return { payload: observeResultSchema.parse(readToolEnvelopePayload(response)?.payload), seen };
  } finally {
    ToolRegistry.clearTools();
  }
}

describe("observe audio_input_unavailable (#13627)", () => {
  test("a device with no audio input carries the typed diagnostic", async () => {
    const result = observationOf(capturedTwoWindowHierarchy());
    const { payload, seen } = await observe(() => diagnostic, result);
    expect(payload.diagnostics).toEqual([diagnostic]);
    expect(seen).toEqual([device]);
    // The served copy carries it; the (cacheable) observation itself is untouched.
    expect(result.diagnostics).toBeUndefined();
  });

  test("a device with audio input carries no diagnostics field", async () => {
    const { payload } = await observe(() => undefined, observationOf(capturedTwoWindowHierarchy()));
    expect(payload.diagnostics).toBeUndefined();
  });

  test("the advertised observe schema inlines diagnostics with no dangling $ref", () => {
    const observe = toolDefinitions.find((tool) => tool.name === "observe");
    const advertised = JSON.stringify(
      (observe?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties
        ?.diagnostics,
    );
    expect(advertised).toContain('"const":"audio_input_unavailable"');
    expect(advertised).not.toContain("$ref");
  });
});
