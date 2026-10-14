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
    super("Could not resolve the prototype viewer template", { cause });
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
