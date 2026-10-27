import { ActionableError } from "../../../../models/ActionableError";

export class PrototypeViewerExtractError extends ActionableError {
  readonly code = "prototype_template_extract";
  constructor(message: string, cause?: unknown) {
    super(
      `Could not extract the prototype viewer template: ${message}. Use a trusted release archive or build one with scripts/ios/prototype-viewer-build.sh.`,
      { cause },
    );
  }
}
