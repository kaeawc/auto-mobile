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
Every device frame is encoded from its `WebSocketResponse` class (#11877), so a field the
device sends is a field the descriptor declares. Descriptor kinds describe the Kotlin schema, including JSON/bridge boundaries;
this guard is at the name/optionality level: it compares top-level field names,
nullability and requiredness only. Field TYPES and nested-type contents are not
compared.

## Captured responses

`android-responses.json` holds replies encoded by the real `WebSocketResponse` serializer
(configured like the device's `responseJson`) in `ResponseContractFixtureTest`, for the
behavioural contract `test/contracts/AndroidCtrlProxyContract.ts`. Timestamps are fixed and
`requestId` is a placeholder the replaying socket substitutes. Regenerate with the same command
as above, using `--tests '*ResponseContractFixtureTest*'`; without the environment variable the
test fails on drift.
