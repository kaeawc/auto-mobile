import {
  reconcileIosDisplayTransition,
  resolveExplicitTarget,
  type DisplayBindingCollector,
  type DisplayBindingCollectorDeps,
  type DisplayTargetBinding,
  type DisplayTargetContext,
  type FinalDisplayBinding,
  type FinalDisplayBindingContext,
} from "./DisplayBindingCollector";
import { displayTransitions } from "../DisplayTransition";
import { DisplaySelectionError, resolveTargetDisplay } from "../DisplaySelection";
import { observedIosDisplay } from "../ObservationDisplay";

export class IosDisplayBindingCollector implements DisplayBindingCollector {
  constructor(private readonly deps: DisplayBindingCollectorDeps) {}

  resolveTarget(context: DisplayTargetContext): DisplayTargetBinding {
    const { explicitlyRouted, requestedPanel } = resolveExplicitTarget(
      this.deps.device(),
      context,
      undefined,
    );
    return {
      observedAndroid: undefined,
      explicitlyRouted,
      requestedPanel,
      requestedDisplayId: undefined,
    };
  }

  bindFinalDisplay(context: FinalDisplayBindingContext): FinalDisplayBinding {
    const { result, displayRequest, explicitlyRouted, preserveDisplayState, observerMode } =
      context;
    let recordProvenance = context.recordProvenance;
    const device = this.deps.device();
    result.display = observedIosDisplay(device, result.viewHierarchy);
    if (
      !observerMode &&
      !preserveDisplayState &&
      displayTransitions.revision(device.deviceId) === recordProvenance.revision
    ) {
      reconcileIosDisplayTransition(
        device.deviceId,
        result,
        explicitlyRouted,
        (device.displays?.panels.length ?? 0) > 1,
      );
      recordProvenance = {
        revision: displayTransitions.revision(device.deviceId),
        identityRevision: displayTransitions.identityRevision(device.deviceId),
      };
    }
    const panel = resolveTargetDisplay(device.displays, displayRequest, {
      focusedPanelKey: result.display.key,
      activePanelKey: result.display.key,
      posture: result.display.posture,
    });
    if (explicitlyRouted && panel.key !== result.display.key) {
      throw new DisplaySelectionError(
        `Display "${panel.key}" is not the active panel on iOS. Active panel: ${result.display.key}`,
      );
    }
    return { recordProvenance };
  }
}
