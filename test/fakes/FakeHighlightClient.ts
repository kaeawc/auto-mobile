import type { HighlightOperationResult, HighlightShape } from "../../src/models";
import type {
  HighlightOptions,
  VisualHighlightClient,
} from "../../src/features/debug/VisualHighlight";

export class FakeHighlightClient implements Pick<VisualHighlightClient, "addHighlight"> {
  readonly addCalls: Array<{ id: string; shape: HighlightShape; options: HighlightOptions }> = [];

  async addHighlight(
    id: string,
    shape: HighlightShape,
    options: HighlightOptions,
  ): Promise<HighlightOperationResult> {
    this.addCalls.push({ id, shape, options });
    return { success: true };
  }
}
