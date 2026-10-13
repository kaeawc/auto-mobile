# network-filter-controller contract fixtures

Root `*.json` lines use contract version 3; `v4/*.json` lines use version 4.
Each is byte-for-byte production `ControllerResult.encodedLine()` output plus
one LF newline. `ControllerContractTests.testCommittedFixturesMatchTheEncoder`
pins both directories. The six original version-3 fixtures remain unchanged and
are encoded through an explicit version-3 path; `shaping-requires-contract-4.json`
adds the default-version argument error. Version-4 `ready.json` carries a mixed
snapshot with one offline rule and one shaped rule, with packet loss unapplied,
and a top-level optional `shapingActivity` containing idle adapter counters.
The version-4 ready line round-trips through the production Codable types.

Every command accepts `--contract-version <n>` only immediately after its name:
`network-filter-controller <command> --contract-version <n> …`. The value must be
exactly `3` or `4`; newest is 4 and absent negotiation defaults to 3. Thus the
unchanged version-3 host continues working against this controller. A missing,
malformed or unsupported value prints a version-4 `unavailable` line naming
supported versions, exiting 2. Its historical "Invalid or repeated --contract-version"
detail stays pinned by `v4/unsupported-contract-version.json`. Later occurrences
are passed unchanged to the command's parser as values or ordinary unexpected
arguments, without negotiation. All other invocation endings carry the negotiated
version, including installation requirements, argument errors and the 8-second timeout.

This build's version-3 `activate` ignores trailing arguments; version-4 `activate`
rejects any arguments after the negotiation pair with an `activate` usage error.
An installed version-3 controller rejects `--contract-version 4` as unknown for
`status`, `snapshot`, `apply`, `reset` and `renew`, printing a version-3 `unavailable`
line. Its `activate` ignores arguments, performs activation and answers with
version-3 lines. A host requiring version 4 must check every returned line's version
and never assume the flag was honoured. Do not use `activate` to capture fixtures.

Version 3 preserves offline wire output, rejects shaping flags with a requirement
for `--contract-version 4`, and omits shaped snapshot rules with one limitation
naming their count and the reason. Its modes remain `allow_only`/`app_offline`.
Version 4 also carries `app_shaped`/`app_mixed`, requests, accepted effect names,
profile units and unapplied components. These describe configuration, not traffic
verification. This build's shaping-capable provider enforces shaped rules on NEW
flows of the attributed app only, implemented and unit-tested only, compiled
unsigned, and unverified against real traffic until the signed run (#10263);
established flows are not shaped. Data-path
NetworkExtension assumptions and all traffic effects remain unverified until
the signed run (#10263). `rule-unsupported-condition.json` still models the
default Core store, which refuses shaping unless explicitly enabled. Version-3
snapshots never contain `shapingActivity`.

Regenerate both directories from the repository root (the environment variable
continues pointing at the root fixture directory):

```sh
AUTOMOBILE_FIXTURE_OUT_DIR="$PWD/test/fixtures/network-filter-controller" \
  swift test --package-path ios/network-filter --filter ControllerContractTests
```

These fixtures are encoder output. Approval, timeout, `ready.json` and all rule
results were not captured from an installed controller. Ready and rule results
require a signed, approved install; `rule-applied-shaped.json` models an explicitly
shaping-capable Core store, also used by this build's provider. No signed,
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
