import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { observeToolScreen } from "../helpers/observeToolScreen";
import { describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../src/models";
import type { CarAppForegroundTemplates, CarAppTemplates } from "../../src/models/CarAppTemplates";
import {
  ANDROID_AUTO_PACKAGE,
  CAR_APP_PROJECTED_NOTE,
  CAR_APP_TEMPLATES_NOTE,
} from "../../src/models/CarAppTemplates";
import type { CarAppTemplatesResolver } from "../../src/features/observe/android/CarAppTemplateReader";
import { registerObserveTools } from "../../src/server/observeTools";
import { observeResultSchema } from "../../src/server/toolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { readToolEnvelopePayload } from "../../src/utils/toolEnvelopePayload";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import toolDefinitions from "../../schemas/tool-definitions.json";
import { capturedTwoWindowHierarchy, observationOf } from "../helpers/prototypeWindowCapture";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "emulator-5554", name: "AAOS", platform: "android" };

const block: CarAppForegroundTemplates = {
  packageName: "com.example.car",
  source: "sdk",
  note: CAR_APP_TEMPLATES_NOTE,
  sessions: [
    {
      id: "session0",
      screens: [
        {
          id: "session0/screen0",
          screenClass: "com.example.car.HomeScreen",
          top: true,
          template: {
            id: "session0/screen0/template",
            type: "TabTemplate",
            headerActions: [
              {
                id: "session0/screen0/template/header/actions/0",
                type: "appIcon",
                hasIcon: true,
                enabled: true,
              },
            ],
            items: [],
            actions: [],
            actionStrips: [],
            tabs: [
              {
                id: "session0/screen0/template/tabs/0",
                contentId: "music",
                title: "Music",
                hasIcon: true,
                active: true,
              },
            ],
            tabContent: {
              id: "session0/screen0/template/tabContent",
              type: "ListTemplate",
              title: "Music",
              headerActions: [],
              items: [],
              actions: [],
              actionStrips: [],
              tabs: [],
            },
          },
        },
      ],
    },
  ],
};

async function observe(resolver: CarAppTemplatesResolver, result: ObserveResult) {
  const screen = new FakeObserveScreen();
  screen.setObserveResult(result);
  const seen: string[] = [];
  try {
    registerObserveTools({
      hidesPrototypeForScreenshot: async () => false,
      createScreen: () => observeToolScreen(screen),
      audioInputDiagnostic: async () => undefined,
      carAppTemplates: async (target, observed) => {
        seen.push(target.deviceId);
        return await resolver(target, observed);
      },
    });
    const tool = ToolRegistry.getTool("observe")!;
    const response = await tool.deviceAwareHandler!(
      device,
      tool.schema.parse({ screenshot: "none" }),
    );
    const raw = readToolEnvelopePayload(response)?.payload;
    return { raw, payload: observeResultSchema.parse(raw), seen };
  } finally {
    ToolRegistry.clearTools();
  }
}

describe("observe carAppTemplates (#16751)", () => {
  test("an app answering the route adds the block to the served copy only", async () => {
    const result = observationOf(capturedTwoWindowHierarchy());
    const { payload, seen } = await observe(async () => block, result);
    expect(payload.carAppTemplates).toEqual(block);
    expect(seen).toEqual([device.deviceId]);
    expect(result.carAppTemplates).toBeUndefined();
  });

  test("an app without the route leaves the payload byte-identical", async () => {
    const without = await observe(
      async () => undefined,
      observationOf(capturedTwoWindowHierarchy()),
    );
    expect(without.payload.carAppTemplates).toBeUndefined();
    expect(JSON.stringify(without.raw)).not.toContain("carAppTemplates");
  });

  test("a projection block (#17826) passes the served output schema unchanged", async () => {
    const projected: CarAppTemplates = {
      source: "sdk",
      note: CAR_APP_TEMPLATES_NOTE,
      projectedBy: ANDROID_AUTO_PACKAGE,
      projectedNote: CAR_APP_PROJECTED_NOTE,
      projected: [{ packageName: block.packageName, sessions: block.sessions }],
    };
    const { payload } = await observe(
      async () => projected,
      observationOf(capturedTwoWindowHierarchy()),
    );
    expect(payload.carAppTemplates).toEqual(projected);
  });

  test("the advertised observe schema inlines carAppTemplates with no dangling $ref", () => {
    const observeTool = toolDefinitions.find((tool) => tool.name === "observe");
    const advertised = JSON.stringify(
      (observeTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties?.carAppTemplates,
    );
    expect(advertised).toContain('"screens"');
    expect(advertised).toContain('"tabContent"');
    expect(advertised).toContain('"projected"');
    expect(advertised).not.toContain("$ref");
  });
});
