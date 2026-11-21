import { ActionableError } from "../../models/ActionableError";

export type AXBridgePreflightCode = "not_aqua" | "accessibility_not_trusted";

export class AXBridgePreflightError extends ActionableError {
  constructor(readonly code: AXBridgePreflightCode) {
    super(
      code === "not_aqua"
        ? "AXBridge requires an Aqua login session. Log in to the macOS desktop and run the daemon from that session."
        : "AXBridge needs Accessibility trust. Enable the daemon's host application in System Settings > Privacy & Security > Accessibility, then retry. The AXBridge executable also requires its own trust.",
    );
    this.name = "AXBridgePreflightError";
  }
}
