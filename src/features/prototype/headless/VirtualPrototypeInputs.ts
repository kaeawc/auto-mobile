import type { PrototypeEvent, PrototypeState } from "../../observe/android/ctrlProxyProtocol";
import type { VirtualPrototypeDevice } from "./VirtualPrototypeDevice";
import {
  findVirtualTapTarget,
  interactionOwnWrite,
  isInertInteraction,
  planVirtualInteraction,
  virtualInteractionRefusal,
  type VirtualPrototypeSnapshot,
  type VirtualTapSelector,
} from "./virtualPrototypeInteraction";

/** One event an input raised on the virtual device, as awaitEvent will return it. */
export interface VirtualPrototypeRaisedEvent {
  sequence: number;
  kind: PrototypeEvent["kind"];
  name: string | null;
}

/** What a `tapOn` or `sendKeys` did on the headless virtual device. */
export interface VirtualPrototypeInputOutcome {
  success: boolean;
  error?: string;
  /** The prototype the input reached. */
  prototypeId?: string;
  /** The node the selector matched. */
  target?: { type: string; id?: string };
  /** False when nothing handles the tap (a dead tap) or the control is disabled. */
  handled?: boolean;
  /** The state key of the text field that holds focus after the input, if any. */
  focusedKey?: string;
  events: VirtualPrototypeRaisedEvent[];
}

/** How a `type` command writes into the focused field. */
export type VirtualTextOperation = "insert" | "replace";

interface Focus {
  id: string;
  key: string;
  maxLength?: number;
}

/** The device surface the inputs need: what is shown, and delivery of planned events. */
export type VirtualPrototypeInputDevice = Pick<
  VirtualPrototypeDevice,
  "snapshots" | "dispatchSteps"
>;

const failure = (error: string): VirtualPrototypeInputOutcome => ({
  success: false,
  error,
  events: [],
});

/**
 * Interaction tools on the headless virtual device (#18360): `tapOn` taps a node of the shown
 * spec and `sendKeys` types into the text field a tap focused, delivering the same events the
 * device runtime would through `VirtualPrototypeDevice.dispatch`, so awaitEvent returns them.
 */
export class VirtualPrototypeInputs {
  private focus: Focus | undefined;

  constructor(private readonly device: VirtualPrototypeInputDevice) {}

  tap(selector: VirtualTapSelector): VirtualPrototypeInputOutcome {
    const shown = this.device.snapshots();
    if (shown.length === 0) {
      return failure(
        "No prototype is shown on the headless virtual device. Call prototype show first.",
      );
    }
    const found = shown
      .map(({ id, snapshot }) => ({
        id,
        snapshot,
        target: findVirtualTapTarget(snapshot, selector),
      }))
      .find((entry) => entry.target !== undefined);
    if (!found?.target) {
      return failure(
        `No visible prototype node matches ${JSON.stringify(selector)} on the headless virtual device. Check the text, id or testTag with prototype status or the automobile:prototype/<id>/web resource.`,
      );
    }
    const { id, snapshot, target } = found;
    const node = {
      type: String(target.node.type),
      ...(typeof target.node.id === "string" ? { id: target.node.id } : {}),
    };
    const interaction = target.interaction;
    if (!interaction || !target.enabled || isInertInteraction(interaction, snapshot.state)) {
      return { success: true, prototypeId: id, target: node, handled: false, events: [] };
    }
    const refusal = virtualInteractionRefusal(interaction.actions, snapshot.spec);
    if (refusal) {
      return { ...failure(refusal), prototypeId: id, target: node };
    }
    if (interaction.type === "focus") {
      const maxLength = target.node.maxLength;
      this.focus = {
        id,
        key: interaction.key,
        ...(typeof maxLength === "number" ? { maxLength } : {}),
      };
    }
    const own = interactionOwnWrite(interaction, snapshot.state);
    return { ...this.run(id, snapshot, own, interaction.actions), target: node };
  }

  typeText(text: string, operation: VirtualTextOperation): VirtualPrototypeInputOutcome {
    return this.writeFocused((current) => (operation === "replace" ? text : `${current}${text}`));
  }

  clearText(): VirtualPrototypeInputOutcome {
    return this.writeFocused(() => "");
  }

  private writeFocused(next: (current: string) => string): VirtualPrototypeInputOutcome {
    const focus = this.focus;
    const shown = focus && this.device.snapshots().find((entry) => entry.id === focus.id);
    if (!focus || !shown) {
      this.focus = undefined;
      return failure(
        "No text field has focus on the headless virtual device. Tap a textField or searchBar with tapOn first, or pass sendKeys a selector.",
      );
    }
    const stored = shown.snapshot.state[focus.key];
    const value = [...next(typeof stored === "string" ? stored : "")]
      .slice(0, focus.maxLength)
      .join("");
    return this.run(focus.id, shown.snapshot, { [focus.key]: value }, []);
  }

  private run(
    id: string,
    snapshot: VirtualPrototypeSnapshot,
    own: PrototypeState,
    actions: Record<string, unknown>[],
  ): VirtualPrototypeInputOutcome {
    const plan = planVirtualInteraction(snapshot, own, actions);
    const sequences = this.device.dispatchSteps(id, plan.steps);
    if (plan.dismissed || plan.blurred) {
      this.focus = undefined;
    }
    return {
      success: true,
      prototypeId: id,
      handled: true,
      ...(this.focus?.id === id ? { focusedKey: this.focus.key } : {}),
      events: plan.steps.slice(0, sequences.length).map((step, index) => ({
        sequence: sequences[index]!,
        kind: step.kind,
        name: step.name,
      })),
    };
  }
}
