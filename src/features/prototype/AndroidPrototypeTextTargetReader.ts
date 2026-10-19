import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { getFocusedTextField, getFocusedTextLength } from "../action/ClearText";
import { scopeObserveResultToLayer } from "../observe/hierarchyLayer";
import type {
  PrototypeTextObserver,
  PrototypeTextReading,
  PrototypeTextTarget,
  PrototypeTextTargetReader,
} from "./prototypeTextTarget";

export class AndroidPrototypeTextTargetReader implements PrototypeTextTargetReader {
  constructor(private readonly observer: PrototypeTextObserver) {}
  async read(target: PrototypeTextTarget, signal?: AbortSignal): Promise<PrototypeTextReading> {
    try {
      const observation = scopeObserveResultToLayer(
        await this.observer.execute({
          hierarchyOnly: true,
          skipScreenshot: true,
          freshness: "fresh",
          display: target.display,
          signal,
        }),
        "prototype",
        "android",
      );
      const hierarchy = observation.viewHierarchy;
      const field = hierarchy && getFocusedTextField(hierarchy);
      if (!hierarchy || !field || field.secure) {
        return { kind: "unverifiable", reason: "no focused readable prototype text field" };
      }
      return {
        kind: "value",
        source: "field",
        value: getFocusedTextLength(hierarchy) === 0 ? "" : (field.value ?? ""),
      };
    } catch (error) {
      logger.warn("Prototype text field observation failed", error);
      return {
        kind: "unverifiable",
        reason: `prototype observation failed: ${errorMessage(error)}`,
      };
    }
  }
}
