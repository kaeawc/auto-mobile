import { ActionableError } from "../../../../models/ActionableError";

export class PrototypeViewerUnsupportedVersionError extends ActionableError {
  readonly code = "prototype_template_unsupported_version";
  constructor(readonly version: string) {
    super(
      `Version ${version}: this build has no published viewer template (a source checkout or a release that predates it); build one with scripts/ios/prototype-viewer-build.sh and set AUTOMOBILE_IOS_PROTOTYPE_VIEWER to the resulting PrototypeViewer.app.`,
    );
  }
}
