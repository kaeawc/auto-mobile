# Android wire contract

`android-wire-contract.json` is generated from the production kotlinx.serialization
request and response descriptors by `WireContractFixtureTest`. No production objects
are instantiated. Nested class descriptors are collected transitively; field order
is declaration order and message/type keys are sorted by serial name.

Regenerate from the repository root:

```sh
cd android && AUTOMOBILE_FIXTURE_OUT_DIR=$PWD/../test/fixtures/android-contract ./gradlew :protocol:test --tests '*WireContractFixtureTest*'
```

Without the environment variable, the Kotlin test asserts byte equality against the
committed fixture. `AndroidWireContract.contract.test.ts` checks the host's exhaustive
field manifests against it; `ctrlProxyProtocol.test.ts` also checks builder frames.
Hand-built response additions are explicitly documented in the contract test pending
#11877. Descriptor kinds describe the Kotlin schema, including JSON/bridge boundaries;
this guard is at the name/optionality level: it compares top-level field names,
nullability and requiredness only. Field TYPES and nested-type contents are not
compared.
