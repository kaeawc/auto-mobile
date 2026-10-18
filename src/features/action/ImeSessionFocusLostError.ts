import { ActionableError } from "../../models/ActionableError";

export class ImeSessionFocusLostError extends ActionableError {
  constructor(readonly reason: "editorFocusLost" | "imeWindowDisappeared") {
    super(
      reason === "editorFocusLost"
        ? "Focused text input lost focus while waiting for a visible IME key."
        : "Selected IME window disappeared while waiting for a visible key.",
    );
    this.name = "ImeSessionFocusLostError";
  }
}
