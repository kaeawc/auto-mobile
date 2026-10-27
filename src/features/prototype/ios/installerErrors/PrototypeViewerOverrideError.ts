import { ActionableError } from "../../../../models/ActionableError";

export class PrototypeViewerOverrideError extends ActionableError {
  readonly code = "prototype_template_override";
  constructor(candidate: string, label: string) {
    super(
      `The prototype viewer configured by ${label} must be an existing app directory containing Info.plist: ${candidate}. Build one with scripts/ios/prototype-viewer-build.sh and set AUTOMOBILE_IOS_PROTOTYPE_VIEWER to the resulting PrototypeViewer.app.`,
    );
  }
}
