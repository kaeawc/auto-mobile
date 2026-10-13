# network-filter-controller contract fixtures

Root `*.json` lines use contract version 3; `v4/*.json` lines use version 4.
Each is byte-for-byte production `ControllerResult.encodedLine()` output plus
one LF newline. `ControllerContractTests.testCommittedFixturesMatchTheEncoder`
pins both directories. The six original version-3 fixtures remain unchanged and
are encoded through an explicit version-3 path; `shaping-requires-contract-4.json`
adds the default-version argument error. Version-4 `ready.json` carries a mixed
snapshot with one offline rule and one shaped rule, with packet loss unapplied.
The version-4 ready line round-trips through the production Codable types.

Every command accepts one `--contract-version <n>` anywhere after its name.
Newest is 4, supported versions are 3 and 4, and absent negotiation defaults to 3
(the last version before negotiation existed). Thus the unchanged version-3 host
continues working against this controller. All invocation endings carry the
negotiated version, including installation requirements, argument errors and the
8-second timeout. Unsupported, repeated or malformed negotiation prints a
version-4 `unavailable` line naming supported versions, exiting 2. An installed
version-3 controller rejects `--contract-version 4` as unknown and prints its own
version-3 `unavailable` line. Unknown flags remain errors in both modes.

Version 3 preserves offline wire output, rejects shaping flags with a requirement
for `--contract-version 4`, and omits shaped snapshot rules with one limitation
naming their count and the reason. Its modes remain `allow_only`/`app_offline`.
Version 4 also carries `app_shaped`/`app_mixed`, requests, accepted effect names,
profile units and unapplied components. These describe configuration, not traffic
verification. This build's provider refuses shaping with `unsupported_condition`;
shaping is neither enforced nor natively verified.

Regenerate both directories from the repository root (the environment variable
continues pointing at the root fixture directory):

```sh
AUTOMOBILE_FIXTURE_OUT_DIR="$PWD/test/fixtures/network-filter-controller" \
  swift test --package-path ios/network-filter --filter ControllerContractTests
```

These fixtures are encoder output. Approval, timeout, `ready.json` and all rule
results were not captured from an installed controller. Ready and rule results
require a signed, approved install; `rule-applied-shaped.json` models an explicitly
shaping-capable Core store, which this build's provider does not use. No signed,
approved controller was run to produce them. The TypeScript bridge tests parse
the original version-3 lines through `ExecNetworkFilterBridge` with a fake exec seam.

An **unsigned** build can print these exact lines for real: version-3 and
version-4 `installation-required.json`, version-4
`unsupported-contract-version.json`, and version-3
`shaping-requires-contract-4.json`. The driver can capture and compare them from
the repository root using only these read-only or argument-error commands:

```sh
swift build --package-path ios/network-filter --product network-filter-controller
mkdir -p scratch/network-filter-fixtures
ios/network-filter/.build/debug/network-filter-controller status \
  > scratch/network-filter-fixtures/installation-required.json
cmp test/fixtures/network-filter-controller/installation-required.json \
  scratch/network-filter-fixtures/installation-required.json
ios/network-filter/.build/debug/network-filter-controller status --contract-version 4 \
  > scratch/network-filter-fixtures/installation-required-v4.json
cmp test/fixtures/network-filter-controller/v4/installation-required.json \
  scratch/network-filter-fixtures/installation-required-v4.json
ios/network-filter/.build/debug/network-filter-controller status --contract-version 9 \
  > scratch/network-filter-fixtures/unsupported-contract-version.json
cmp test/fixtures/network-filter-controller/v4/unsupported-contract-version.json \
  scratch/network-filter-fixtures/unsupported-contract-version.json
ios/network-filter/.build/debug/network-filter-controller apply \
  --managed /fixture/Devices DFBF2D27-6674-42EA-AFC4-AB702275D1D4 \
  --bundle-id dev.jasonpearson.automobile.fixture --owner fixture-session \
  --owner-generation 1759900000000 --revision 3 --lease-ms 15000 --delay-ms 100 \
  > scratch/network-filter-fixtures/shaping-requires-contract-4.json
cmp test/fixtures/network-filter-controller/shaping-requires-contract-4.json \
  scratch/network-filter-fixtures/shaping-requires-contract-4.json
```

The status commands exit 1 and the argument-error commands exit 2 after writing
the line; run each capture and `cmp` separately if the shell uses `set -e`.
Inside a restricted sandbox, add `--disable-sandbox --scratch-path ios/network-filter/.build`
to SwiftPM commands and keep shared/module caches inside the worktree. Implementation
validation builds and runs pure tests only; binary captures belong to the driver.
