import { stringifyToolResponse } from "../utils/toolUtils";

/** Request-local renderings: inline text strips extras; complete JSON preserves them. */
export class ToolResponseSerialization {
  private readonly inline = new Map<unknown, string>();
  private readonly complete = new Map<unknown, string>();

  text(payload: unknown): string {
    if (!this.inline.has(payload)) {
      this.inline.set(payload, stringifyToolResponse(payload));
    }
    return this.inline.get(payload)!;
  }

  stripExtras(payload: Record<string, unknown>): Record<string, unknown> {
    const text = this.text(payload);
    return this.artifact(payload) === text ? payload : JSON.parse(text);
  }

  artifact(payload: unknown): string {
    if (!this.complete.has(payload)) {
      this.complete.set(payload, JSON.stringify(payload));
    }
    return this.complete.get(payload)!;
  }
}
