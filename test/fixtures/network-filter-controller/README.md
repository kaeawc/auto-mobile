# network-filter-controller contract fixtures

Each `*.json` file is one line of `network-filter-controller` output (contract
version 2), byte-for-byte as the production `ControllerResult.encodedLine()`
encoder in `ios/network-filter/Sources/NetworkFilterCore/ControllerContract.swift`
writes it, plus the trailing newline the controller prints.
`ControllerContractTests.testCommittedFixturesMatchTheEncoder` fails when a
fixture drifts from that encoder. `ready.json` nests a provider snapshot that the
test decodes from JSON into the production `ProbeSnapshot` type and re-encodes.

Regenerate from the repository root:

```sh
AUTOMOBILE_FIXTURE_OUT_DIR="$PWD/test/fixtures/network-filter-controller" \
  swift test --package-path ios/network-filter --filter ControllerContractTests
```

These are encoder output, not a run of the installed controller: no signed,
approved controller was run to produce them. The TypeScript bridge tests
(`test/features/network-filter/NetworkFilterBridge.test.ts`) parse them through
`ExecNetworkFilterBridge` with a fake exec seam.
