import { ActionableError } from "../../../models/ActionableError";

/** URL delivery is unsafe when the simulator cannot bring ProtoViewer to the foreground. */
export class ProtoViewerForegroundError extends ActionableError {
  constructor(options?: ErrorOptions) {
    super(
      'Could not bring ProtoViewer to the foreground on the iOS simulator. An "Open in ProtoViewer?" alert may be pending; dismiss it, open ProtoViewer manually, and retry.',
      options,
    );
    this.name = "ProtoViewerForegroundError";
  }
}
