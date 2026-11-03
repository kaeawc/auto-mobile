import { describe, expect, test } from "bun:test";
import toolDefinitions from "../../../schemas/tool-definitions.json";
import { renderPrototypeGuide } from "../../../src/features/prototype/prototypeGuide";
import { PROTOTYPE_PLATFORM_MODULES } from "../../../src/features/prototype/prototypePlatform";
import {
  PROTOTYPE_PLATFORM_DRIVING_TOOLS,
  renderPlatformDrivingTools,
} from "../../../src/features/prototype/prototypePlatformDrivingTools";

const productionModules = Object.entries(PROTOTYPE_PLATFORM_MODULES)
  .filter(([, module]) => module.placeholder !== true)
  .map(([name]) => name)
  .sort();
const toolNames = new Set(toolDefinitions.map((tool: { name: string }) => tool.name));

describe("platform driving tools", () => {
  test("covers exactly the production platform modules", () => {
    expect(Object.keys(PROTOTYPE_PLATFORM_DRIVING_TOOLS).sort()).toEqual(productionModules);
  });

  test("names only registered MCP tools", () => {
    const unknown = Object.values(PROTOTYPE_PLATFORM_DRIVING_TOOLS)
      .flatMap((entry) => entry.tools)
      .filter((tool) => !toolNames.has(tool));
    expect(unknown).toEqual([]);
  });

  test("renders one row per module with its tools", () => {
    const table = renderPlatformDrivingTools({
      clipboard: { tools: ["clipboard"], note: "set it" },
      cast: { tools: [], note: "none" },
    });
    expect(table).toContain("| `clipboard` | `clipboard` | set it |");
    expect(table).toContain("| `cast` | - | none |");
  });

  test("appears in the platform section of the guide", () => {
    const guide = renderPrototypeGuide();
    const section = guide.slice(guide.indexOf("## Platform features"));
    expect(section).toContain(renderPlatformDrivingTools());
  });
});
