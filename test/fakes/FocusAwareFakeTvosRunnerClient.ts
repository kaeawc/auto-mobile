import capture from "../fixtures/tvos-xcuitest/tvos-runner-hierarchy-focus-b01.json";
import { FakeTvosRunnerClient } from "./FakeTvosRunnerClient";
import type { TvosCommand, TvosRunnerClient } from "../../src/features/tvos/TvosRunnerClient";
import type { ElementBounds } from "../../src/models";

interface CapturedNode {
  "resource-id": string;
  text: string;
  focused: string;
  bounds: ElementBounds;
  node?: CapturedNode[];
}

/** Moves only captured grid nodes, deriving neighbours from their captured frames. */
export class FocusAwareFakeTvosRunnerClient extends FakeTvosRunnerClient {
  readonly buttons: CapturedNode[] = [];
  ignorePresses = false;
  readonly blockedActions = new Set<string>();
  afterPress?: () => void;

  constructor(initialFocus: string | undefined = "B01") {
    const tree = structuredClone(capture.data);
    super(tree);
    const visit = (node: CapturedNode): void => {
      if (/^B\d\d$/.test(node["resource-id"])) {
        this.buttons.push(node);
      }
      node.node?.forEach(visit);
    };
    visit(tree.hierarchy);
    this.focus(initialFocus);
  }

  focus(id: string | undefined): void {
    for (const button of this.buttons) {
      button.focused = button["resource-id"] === id ? "true" : "false";
    }
  }

  override async request(
    command: TvosCommand,
    signal?: AbortSignal,
    options?: Parameters<TvosRunnerClient["request"]>[2],
  ): Promise<unknown> {
    const result = await super.request(command, signal, options);
    if (command.type === "request_press_button") {
      if (!this.ignorePresses && !this.blockedActions.has(command.action)) {
        this.move(command.action);
      }
      this.afterPress?.();
    }
    return result;
  }

  private move(action: string): void {
    const focus = this.buttons.find((button) => button.focused === "true");
    if (!focus || !["up", "down", "left", "right"].includes(action)) {
      return;
    }
    const horizontal = action === "left" || action === "right";
    const centre = (bounds: ElementBounds): number =>
      horizontal ? (bounds.left + bounds.right) / 2 : (bounds.top + bounds.bottom) / 2;
    const sign = action === "right" || action === "down" ? 1 : -1;
    const distance = (button: CapturedNode): number =>
      (centre(button.bounds) - centre(focus.bounds)) * sign;
    const neighbours = this.buttons
      .filter((button) => {
        const a = focus.bounds;
        const b = button.bounds;
        const overlaps = horizontal
          ? a.top < b.bottom && b.top < a.bottom
          : a.left < b.right && b.left < a.right;
        return overlaps && distance(button) > 0;
      })
      .sort((a, b) => distance(a) - distance(b));
    if (neighbours[0]) {
      this.focus(neighbours[0]["resource-id"]);
    }
  }
}
