import { ActionableError } from "../../../../models/ActionableError";

export class PrototypeViewerDownloadDisabledError extends ActionableError {
  readonly code = "prototype_template_download_disabled";
  constructor() {
    super(
      "The prototype viewer download is disabled by AUTOMOBILE_SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD and no verified cached copy exists. Build one with scripts/ios/prototype-viewer-build.sh and set AUTOMOBILE_IOS_PROTOTYPE_VIEWER to the resulting PrototypeViewer.app.",
    );
  }
}
