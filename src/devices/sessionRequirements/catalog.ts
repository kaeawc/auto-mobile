import { failure, success } from "./result";
import type {
  IosArchetype,
  IosCatalogModel,
  IosExactModelReference,
  IosModelType,
  IosSessionDeviceCatalog,
  RequirementResult,
  SessionDeviceCatalog,
  SessionRequirementDefaults,
} from "./types";

export function iosModelTypeArchetype(modelType: IosModelType): IosArchetype {
  if (modelType.family === "duo") {
    return "duo";
  }
  return modelType.family === "ipad" ? "tablet" : "phone";
}

function normalizedSize(size: string | undefined): string | undefined {
  if (size === undefined) {
    return undefined;
  }
  const [whole, fraction] = size.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction?.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

export function iosModelTypesEqual(a: IosModelType, b: IosModelType): boolean {
  if (a.family !== b.family || a.variant !== b.variant) {
    return false;
  }
  if (a.family !== "ipad" || b.family !== "ipad") {
    return true;
  }
  return normalizedSize(a.sizeInches) === normalizedSize(b.sizeInches);
}

/** Model-type predicate membership; an omitted requested iPad size is unconstrained. */
export function iosModelTypeMatches(requested: IosModelType, candidate: IosModelType): boolean {
  if (requested.family !== candidate.family || requested.variant !== candidate.variant) {
    return false;
  }
  if (requested.family !== "ipad" || candidate.family !== "ipad") {
    return true;
  }
  return (
    requested.sizeInches === undefined ||
    normalizedSize(requested.sizeInches) === normalizedSize(candidate.sizeInches)
  );
}

export function describeIosModelType(modelType: IosModelType): string {
  if (modelType.family === "duo") {
    return "Duo";
  }
  if (modelType.family === "iphone") {
    return `iPhone ${modelType.variant}`;
  }
  const size = modelType.sizeInches === undefined ? "" : ` ${modelType.sizeInches}-inch`;
  return `iPad ${modelType.variant}${size}`;
}

function modelReferenceMatches(model: IosCatalogModel, reference: IosExactModelReference): boolean {
  if (reference.namespace === "product-model") {
    return model.modelIdentifier === reference.value;
  }
  if (reference.namespace === "simulator-device-type") {
    return model.simulatorDeviceTypeIdentifier === reference.value;
  }
  return model.aliases?.includes(reference.value) === true;
}

export function resolveIosModelReference(
  reference: IosExactModelReference,
  catalog: IosSessionDeviceCatalog,
  field = "hardware.model",
): RequirementResult<IosCatalogModel> {
  const matches = catalog.models.filter((model) => modelReferenceMatches(model, reference));
  if (matches.length > 1) {
    return failure(
      reference.namespace === "alias" ? "ambiguous_model_alias" : "catalog_metadata_invalid",
      `${field} '${reference.value}' resolves to more than one catalog model.`,
      { field },
    );
  }
  const model = matches[0];
  if (!model) {
    return failure(
      "unsupported_hardware",
      `${field} '${reference.value}' is not present in the installed iOS catalog.`,
      { field },
    );
  }
  if (model.metadataState !== "current") {
    return failure(
      "catalog_metadata_invalid",
      `${field} '${reference.value}' has stale catalog metadata.`,
      { field },
    );
  }
  if (!model.archetype || !model.modelType) {
    return failure(
      "catalog_metadata_invalid",
      `${field} '${reference.value}' lacks explicit archetype or model-type metadata.`,
      { field },
    );
  }
  if (iosModelTypeArchetype(model.modelType) !== model.archetype) {
    return failure(
      "catalog_metadata_invalid",
      `${field} '${reference.value}' has conflicting archetype and model-type metadata.`,
      { field },
    );
  }
  return success(model);
}

export function validateContext(
  platform: "ios" | "android",
  defaults: SessionRequirementDefaults,
  catalog: SessionDeviceCatalog,
): RequirementResult<true> {
  if (defaults.platform !== platform || catalog.platform !== platform) {
    return failure(
      "invalid_config",
      `Requirement, defaults, and catalog must all target ${platform}.`,
    );
  }
  if (!defaults.policyVersion) {
    return failure("invalid_config", "Default policy version must be non-empty.", {
      field: "policyVersion",
    });
  }
  if (catalog.provenance.state !== "ready") {
    return failure(
      "catalog_unavailable",
      catalog.provenance.message ?? `${platform} catalog is unavailable.`,
      { transient: true },
    );
  }
  if (!catalog.provenance.source || !catalog.provenance.revision) {
    return failure("catalog_metadata_invalid", "Catalog provenance is incomplete.");
  }
  return success(true);
}
