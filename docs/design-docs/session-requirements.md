# Session device requirements

Status: bounded provider contract milestone. This module is pure TypeScript. It
does not read platform catalogs, allocate devices, or expose daemon tools.

## Consumer contract

`SessionDeviceRequirement` describes only device intent:

```ts
type SessionDeviceRequirement =
  | {
      schemaVersion: 1;
      platform: "ios";
      hardware: IosHardwareSelector;
      os: OsSelector;
    }
  | {
      schemaVersion: 1;
      platform: "android";
      hardware: AndroidHardwareSelector;
      os: OsSelector;
    };
```

There are no slot, lane, capacity, pool, or prior-device inputs. Those are
provider-owned allocation details. Runtime parsing rejects unknown fields so an
old allocation concept cannot accidentally become part of the versioned
request.

iOS hardware has four explicit selector kinds:

- `exact-model` carries a namespaced product-model code, CoreSimulator device
  type identifier, or configured exact alias;
- `model-type` carries structured membership such as iPhone Pro, iPhone Pro
  Max, iPhone Air, or an iPad family and optional size;
- `archetype` is `phone`, `tablet`, or `duo`;
- `omitted` requests the configured default archetype.

Android hardware is `phone`, `tablet`, or `omitted`. Exact Android profiles,
OEM selectors, foldables, and other categories are not accepted at this
boundary.

OS selectors are `exact`, `major`, `minimum`, and `omitted`. Their kind is
always explicit. Values are positive dotted numeric releases. Android API
levels, package revisions, letter releases, and QPR labels are not interpreted
as release versions.

## Numeric OS semantics

Numeric components compare without floating-point coercion. Leading zeroes and
trailing zero components normalize away:

| Predicate        | Candidate | Result   |
| ---------------- | --------- | -------- |
| exact `27.0`     | `27.0.0`  | match    |
| exact `27.0`     | `27.0.1`  | mismatch |
| exact `27.0`     | `27.1`    | mismatch |
| major `27`       | `27.9.4`  | match    |
| major `27`       | `28.0`    | mismatch |
| minimum `27.0.1` | `28`      | match    |

An omitted OS selector becomes the configured predicate before pool matching.
It never follows the active SDK or newest catalog entry implicitly.

Android releases retain `apiLevel` separately from `osVersion`. Each catalog
release states whether source metadata proves major, minor, or patch precision.
An exact request that needs finer evidence returns
`unsupported_version_precision`; API level or package revision cannot fill the
gap.

Resolved and pooled Android profiles retain that precision. Reuse applies the
same evidence check as creation: a major-only observation cannot prove an exact
minor release or a minimum within that major, even if a supplied version string
includes a finer component. A later proven major can satisfy that minimum.

## Catalog adapter boundary

Native adapters project source-backed facts into `IosSessionDeviceCatalog` or
`AndroidSessionDeviceCatalog`. The resolver performs no I/O.

An iOS model contains both namespaces:

```ts
{
  simulatorDeviceTypeIdentifier: string;
  modelIdentifier?: string;
  name: string;
  productFamily: string;
  aliases?: readonly string[];
  archetype?: "phone" | "tablet" | "duo";
  modelType?: IosModelType;
  metadataState: "current" | "stale";
  minOsVersion?: string;
  maxOsVersion?: string | null;
}
```

`name` and `productFamily` are diagnostics, not matching inputs. Exact aliases
use equality and must resolve to one model. Missing, ambiguous, stale, or
unclassified model metadata cannot satisfy a predicate. No substring turns Pro
into Pro Max, infers an iPad size, or classifies a future iPhone as phone. A
requested iPad size matches exactly; an omitted size accepts any size in the
requested iPad family.

iOS releases carry runtime identifier and numeric OS version. Android catalogs
carry classified phone/tablet profile identifiers and releases with system
image package, OS version, evidence precision, API level, ABI, and image
flavor. ABI and flavor therefore remain explicit provider policy in the
resolved profile.

Catalog provenance includes source, revision, and availability state. An
unavailable catalog is a transient `catalog_unavailable` result, never evidence
that hardware or a runtime is permanently unsupported.

## Defaults and pool-first resolution

Defaults form a typed, acyclic hierarchy because each edge can only descend one
level:

```text
iOS omitted -> archetype -> model type -> exact catalog model
Android omitted -> archetype -> exact installed emulator profile
```

An explicit archetype starts at the archetype level. An explicit model type
skips the archetype default. An explicit model skips both preceding levels.
Missing, duplicate, conflicting, unknown, or stale defaults return typed
configuration or catalog errors.

Normalization applies only the omitted hardware archetype and omitted OS
predicate. A pool can therefore satisfy an explicit coarse phone request with
any current, classified phone that meets the OS predicate. It does not have to
equal the model used for a new creation. On a pool miss,
`resolveSessionDeviceProfile` descends the remaining hardware defaults to one
exact creation profile.

For major and minimum OS creation, resolution first uses the configured
preferred release when it is installed and satisfies the predicate. Otherwise
it chooses the highest satisfying installed release. Stable runtime/package
identity breaks equal-version ties, so catalog order never changes the result.
Exact predicates consider only numerically equal releases.

Known iOS model/runtime bounds can prove `runtime_incompatible`. The resolver
does not replace an exact model or exact/default-exact OS to repair the pair.
Absent compatibility bounds produce `compatibility: "unknown"` so the native
creation authority can attempt the preserved exact pair. Malformed bounds are
invalid catalog metadata.

## Duo policy

Duo is a recognized iOS archetype and model type. It is distinct from phone,
including when a catalog name or identifier begins with `iPhone`.

Execution is disabled in this milestone. Normalization returns
`capability_disabled` for an explicit Duo archetype, Duo model type, exact model
classified as Duo, omitted default archetype of Duo, or known Duo model farther
down the applicable default path. This check occurs before pool matching or
creation resolution. A direct Duo request/default needs no installed Duo model,
runtime, or creation default.

## Pure API and provenance

The public module exports:

```ts
parseSessionDeviceRequirement(input);
normalizeSessionDeviceRequirement(request, defaults, catalog);
matchSessionDevice(normalized, candidate);
resolveSessionDeviceProfile(normalized, defaults, catalog);
```

Parsing and resolution return `RequirementResult<T>`, with a typed error code
instead of collapsing malformed input, disabled capability, unavailable
catalog, missing runtime, incompatible pair, and capacity into one result.
Capacity remains outside this pure milestone.

Normalized requirements retain the original request, effective pool
predicates, default-policy version, catalog source/revision, and which omitted
dimensions were defaulted. Resolved profiles add exact hardware/runtime
identity, the hardware default path, and whether OS resolution used exact,
preferred, or highest-satisfying selection. A broker can attach this value to a
fresh session while keeping allocation records and lifecycle journals private.
