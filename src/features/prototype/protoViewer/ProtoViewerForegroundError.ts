import { ActionableError } from "../../../models/ActionableError";

/** The simulator must bring ProtoViewer forward to consume its file inbox. */
export class ProtoViewerForegroundError extends ActionableError {
  constructor(options?: ErrorOptions) {
    super(
      "Could not bring ProtoViewer to the foreground on the iOS simulator. Open ProtoViewer manually and retry.",
      options,
    );
    this.name = "ProtoViewerForegroundError";
  }
}
