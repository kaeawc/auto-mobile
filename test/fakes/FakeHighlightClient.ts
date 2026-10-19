import {
  ActionableError,
  type HighlightOperationResult,
  type HighlightShape,
} from "../../src/models";
import { highlightShapeSchema } from "../../src/features/debug/VisualHighlight";
import {
  type HighlightOptions,
  type VisualHighlightClient,
} from "../../src/features/debug/VisualHighlightClient";

export class FakeHighlightClient implements Pick<VisualHighlightClient, "addHighlight"> {
  readonly addCalls: Array<{ id: string; shape: HighlightShape; options: HighlightOptions }> = [];
  private nextFailure: string | undefined;

  /** The next accepted request fails the way a device-reported failure does: it rejects. */
  failNext(message: string): void {
    this.nextFailure = message;
  }

  async addHighlight(
    id: string,
    shape: HighlightShape,
    options: HighlightOptions,
  ): Promise<HighlightOperationResult> {
    if (options.device && options.device.platform !== options.platform) {
      throw new ActionableError(
        `Highlight platform mismatch: requested ${options.platform}, device is ${options.device.platform}.`,
      );
    }
    if (id.length === 0) {
      throw new ActionableError("Highlight id must be a non-empty string");
    }
    const parsed = highlightShapeSchema.safeParse(shape);
    if (!parsed.success) {
      throw new ActionableError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    this.addCalls.push({ id, shape, options });
    if (this.nextFailure !== undefined) {
      const message = this.nextFailure;
      this.nextFailure = undefined;
      throw new ActionableError(message);
    }
    return { success: true };
  }
}
