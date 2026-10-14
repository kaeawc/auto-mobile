import { ActionableError } from "../../../models/ActionableError";

export class PrototypeInstallPhysicalDeviceError extends ActionableError {
  readonly code = "prototype_install_physical_device";
  constructor(cause?: unknown) {
    super("Prototype viewer installation is simulator only", { cause });
  }
}

export class InvalidPrototypeIdError extends ActionableError {
  readonly code = "invalid_prototype_id";
  constructor(cause?: unknown) {
    super("Prototype id must contain non-whitespace characters", { cause });
  }
}

export class TemplateResolveError extends ActionableError {
  readonly code = "prototype_template_resolve";
  constructor(cause?: unknown) {
    super(
      `Could not resolve the prototype viewer template${cause instanceof ActionableError ? `: ${cause.message}` : ""}`,
      { cause },
    );
  }
}

export class TemplateCopyError extends ActionableError {
  readonly code = "prototype_template_copy";
  constructor(cause?: unknown) {
    super("Could not copy the prototype viewer template", { cause });
  }
}

export class PlistRewriteError extends ActionableError {
  readonly code = "prototype_plist_rewrite";
  constructor(cause?: unknown) {
    super("Could not rewrite the prototype viewer plist", { cause });
  }
}

export class IconRenderError extends ActionableError {
  readonly code = "prototype_icon_render";
  constructor(cause?: unknown) {
    super("Could not render or write the prototype viewer icons", { cause });
  }
}

export class SimctlInstallError extends ActionableError {
  readonly code = "prototype_simctl_install";
  constructor(cause?: unknown) {
    super("Could not install the prototype viewer", { cause });
  }
}

export class PrototypeListError extends ActionableError {
  readonly code = "prototype_list";
  constructor(cause?: unknown) {
    super("Could not list installed prototype viewers", { cause });
  }
}

export class PrototypeUninstallError extends ActionableError {
  readonly code = "prototype_uninstall";
  constructor(cause?: unknown) {
    super("Could not uninstall the prototype viewer", { cause });
  }
}

export class DataContainerError extends ActionableError {
  readonly code = "prototype_data_container";
  constructor(cause?: unknown) {
    super("Could not access the prototype viewer data container", { cause });
  }
}

export class DataWriteError extends ActionableError {
  readonly code = "prototype_data_write";
  constructor(cause?: unknown) {
    super("Could not write the prototype viewer spec", { cause });
  }
}

export class NotPrototypeBundleError extends ActionableError {
  readonly code = "not_prototype_bundle";
  constructor(cause?: unknown) {
    super("Refusing to uninstall a bundle outside the prototype prefix", { cause });
  }
}

export class CodesignError extends ActionableError {
  readonly code = "prototype_codesign";
  constructor(
    readonly step: "sign" | "verify",
    cause?: unknown,
  ) {
    super(`Could not ${step} the prototype viewer signature`, { cause });
  }
}

export class PrototypeViewerChecksumMismatchError extends ActionableError {
  readonly code = "prototype_template_checksum_mismatch";
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Prototype viewer checksum verification failed. Expected: ${expected}, Got: ${actual}. The downloaded archive was deleted; retry with a trusted release or build a local template.`,
    );
  }
}

export class PrototypeViewerDownloadError extends ActionableError {
  readonly code = "prototype_template_download";
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class PrototypeViewerUnsupportedVersionError extends ActionableError {
  readonly code = "prototype_template_unsupported_version";
  constructor(readonly version: string) {
    super(
      `Version ${version}: this build has no published viewer template (a source checkout or a release that predates it); build one with scripts/ios/prototype-viewer-build.sh and set AUTOMOBILE_IOS_PROTOTYPE_VIEWER to the resulting PrototypeViewer.app.`,
    );
  }
}

export class PrototypeViewerDownloadDisabledError extends ActionableError {
  readonly code = "prototype_template_download_disabled";
  constructor() {
    super(
      "The prototype viewer download is disabled by AUTOMOBILE_SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD and no verified cached copy exists. Build one with scripts/ios/prototype-viewer-build.sh and set AUTOMOBILE_IOS_PROTOTYPE_VIEWER to the resulting PrototypeViewer.app.",
    );
  }
}

export class PrototypeViewerOverrideError extends ActionableError {
  readonly code = "prototype_template_override";
  constructor(candidate: string, label: string) {
    super(
      `The prototype viewer configured by ${label} must be an existing app directory containing Info.plist: ${candidate}. Build one with scripts/ios/prototype-viewer-build.sh and set AUTOMOBILE_IOS_PROTOTYPE_VIEWER to the resulting PrototypeViewer.app.`,
    );
  }
}

export class PrototypeViewerExtractError extends ActionableError {
  readonly code = "prototype_template_extract";
  constructor(message: string, cause?: unknown) {
    super(
      `Could not extract the prototype viewer template: ${message}. Use a trusted release archive or build one with scripts/ios/prototype-viewer-build.sh.`,
      { cause },
    );
  }
}
