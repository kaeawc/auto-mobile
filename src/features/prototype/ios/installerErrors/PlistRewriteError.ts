import { ActionableError } from "../../../../models/ActionableError";

export class PlistRewriteError extends ActionableError {
  readonly code = "prototype_plist_rewrite";
  constructor(cause?: unknown) {
    super("Could not rewrite the prototype viewer plist", { cause });
  }
}
