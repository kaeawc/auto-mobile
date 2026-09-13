import { afterEach, expect, test } from "bun:test";
import { registerHighlightTools } from "../../src/server/highlightTools";
import { registerVideoRecordingTools } from "../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

afterEach(() => (ToolRegistry as any).tools.clear());
test("highlight and recording accept only unstyled circles", () => {
  registerHighlightTools();
  registerVideoRecordingTools();
  const circle = { type: "circle", bounds: { x: 0, y: 0, width: 100, height: 80 } };
  for (const name of ["highlight", "videoRecording"]) {
    const tool = ToolRegistry.getTool(name)!;
    const input = (shape: unknown) =>
      name === "highlight" ? { shape } : { action: "start", highlights: [{ shape }] };
    expect(tool.schema.safeParse(input(circle)).success).toBe(true);
    for (const shape of [
      { ...circle, type: "box" },
      { ...circle, type: "path" },
      { ...circle, style: { strokeColor: "#00FF00" } },
      { ...circle, points: [{ x: 0, y: 0 }] },
    ]) {
      expect(tool.schema.safeParse(input(shape)).success).toBe(false);
    }
  }
});
