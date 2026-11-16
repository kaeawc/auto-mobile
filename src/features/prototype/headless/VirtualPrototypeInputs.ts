import type { PrototypeEvent, PrototypeState } from "../../observe/android/ctrlProxyProtocol";
import type { VirtualPrototypeDevice } from "./VirtualPrototypeDevice";
import {
  findVirtualTapTarget,
  interactionOwnWrite,
  isInertInteraction,
  isVirtualFieldFocusable,
  planVirtualInteraction,
  virtualInteractionRefusal,
  type VirtualPrototypeSnapshot,
  type VirtualTapSelector,
  type VirtualTapTarget,
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

/** The device surface the inputs need: what is shown, delivery of planned events, final state. */
export type VirtualPrototypeInputDevice = Pick<
  VirtualPrototypeDevice,
  "snapshots" | "dispatchSteps" | "settle"
>;

const failure = (error: string): VirtualPrototypeInputOutcome => ({
  success: false,
  error,
  events: [],
});

const NO_FOCUS =
  "No text field has focus on the headless virtual device. Tap a textField or searchBar with tapOn first, or pass sendKeys a selector.";

/** One input to plan: the control's own write, its actions, and the focus it leaves. */
interface PlannedInput {
  own: PrototypeState;
  actions: Record<string, unknown>[];
  focus: Focus | undefined;
}

/** The shown prototype a selector reached and the node it matched there. */
interface Located {
  id: string;
  snapshot: VirtualPrototypeSnapshot;
  target: VirtualTapTarget;
  node: { type: string; id?: string };
}

/**
 * Interaction tools on the headless virtual device (#18360): `tapOn` taps a node of the shown
 * spec and `sendKeys` types into the text field a tap or its selector focused, delivering the same
 * events the device runtime would through `VirtualPrototypeDevice.dispatch`, so awaitEvent returns
 * them.
 */
export class VirtualPrototypeInputs {
  private focus: Focus | undefined;

  constructor(private readonly device: VirtualPrototypeInputDevice) {}

  tap(selector: VirtualTapSelector): VirtualPrototypeInputOutcome {
    const located = this.locate(selector);
    if (!("snapshot" in located)) {
      return located;
    }
    const { id, snapshot, target, node } = located;
    const interaction = target.interaction;
    if (!interaction || !target.enabled || isInertInteraction(interaction, snapshot.state)) {
      return { success: true, prototypeId: id, target: node, handled: false, events: [] };
    }
    const refusal = virtualInteractionRefusal(interaction.actions, snapshot.spec);
    if (refusal) {
      return { ...failure(refusal), prototypeId: id, target: node };
    }
    const own = interactionOwnWrite(interaction, snapshot.state);
    const focus = interaction.type === "focus" ? focusOf(id, interaction.key, target) : undefined;
    return {
      ...this.run(id, snapshot, { own, actions: interaction.actions, focus }),
      target: node,
    };
  }

  /**
   * Focuses the text field a `sendKeys` selector names, as the device's focus action does: no tap
   * handler runs, and a match that is not an enabled textField or searchBar is refused.
   */
  focusOn(selector: VirtualTapSelector): VirtualPrototypeInputOutcome {
    const located = this.locate(selector);
    if (!("snapshot" in located)) {
      return located;
    }
    const { id, target, node } = located;
    const interaction = target.interaction;
    if (interaction?.type !== "focus") {
      return {
        ...failure(
          `The sendKeys selector ${JSON.stringify(selector)} matched a ${node.type}, not a textField or searchBar; name the field to type into.`,
        ),
        prototypeId: id,
        target: node,
      };
    }
    if (!target.enabled) {
      return {
        ...failure(`The ${node.type} the sendKeys selector names is disabled.`),
        prototypeId: id,
        target: node,
      };
    }
    this.focus = focusOf(id, interaction.key, target);
    return {
      success: true,
      prototypeId: id,
      target: node,
      handled: true,
      focusedKey: interaction.key,
      events: [],
    };
  }

  typeText(text: string, operation: VirtualTextOperation): VirtualPrototypeInputOutcome {
    return this.writeFocused((current) => (operation === "replace" ? text : `${current}${text}`));
  }

  clearText(): VirtualPrototypeInputOutcome {
    return this.writeFocused(() => "");
  }

  /** The first shown prototype, newest first, with a visible node the selector names. */
  private locate(selector: VirtualTapSelector): Located | VirtualPrototypeInputOutcome {
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
    if (target.undecidable !== undefined) {
      return {
        ...failure(
          `The headless virtual device cannot decide the ${target.undecidable} yet; run the input on a device.`,
        ),
        prototypeId: id,
        target: node,
      };
    }
    return { id, snapshot, target, node };
  }

  private writeFocused(next: (current: string) => string): VirtualPrototypeInputOutcome {
    const focus = this.focus;
    const shown = focus && this.device.snapshots().find((entry) => entry.id === focus.id);
    if (!focus || !shown || !isVirtualFieldFocusable(shown.snapshot, focus.key)) {
      // A field hidden, patched away or left on another screen can no longer take input.
      this.focus = undefined;
      return failure(NO_FOCUS);
    }
    const stored = shown.snapshot.state[focus.key];
    const value = [...next(typeof stored === "string" ? stored : "")]
      .slice(0, focus.maxLength)
      .join("");
    return this.run(focus.id, shown.snapshot, {
      own: { [focus.key]: value },
      actions: [],
      focus,
    });
  }

  /** Plans the interaction, delivers its events, then leaves its final state on the device. */
  private run(
    id: string,
    snapshot: VirtualPrototypeSnapshot,
    { own, actions, focus }: PlannedInput,
  ): VirtualPrototypeInputOutcome {
    const plan = planVirtualInteraction(snapshot, own, actions);
    if (plan.rejection !== undefined) {
      return { ...failure(plan.rejection), prototypeId: id };
    }
    const sequences = this.device.dispatchSteps(id, plan.steps);
    if (!plan.dismissed) {
      this.device.settle(id, plan);
    }
    this.focus = plan.dismissed || plan.blurred ? undefined : (focus ?? this.focus);
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

function focusOf(id: string, key: string, target: VirtualTapTarget): Focus {
  const maxLength = target.node.maxLength;
  return { id, key, ...(typeof maxLength === "number" ? { maxLength } : {}) };
}
