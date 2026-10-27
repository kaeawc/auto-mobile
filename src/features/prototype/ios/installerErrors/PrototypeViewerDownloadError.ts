import { ActionableError } from "../../../../models/ActionableError";

export class PrototypeViewerDownloadError extends ActionableError {
  readonly code = "prototype_template_download";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}
