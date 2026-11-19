#!/bin/bash
# The values below are jq programs ($v is a jq variable, not a shell one) read
# by the scripts that source this file.
# shellcheck disable=SC2016,SC2034
#
# jq programs that pick a usable iOS Simulator runtime, simulator and iPhone
# device type from `xcrun simctl list --json runtimes` / `... devices`.
#
# A runtime is usable when it is an iOS runtime, `isAvailable` is not false, it
# lists at least one supported architecture (an empty list is the "SimDevice
# native architecture is nil" failure), it supports at least one non-Duo iPhone
# device type (iOS-27-1 supports only iPhone Duo), and it is not a device-specific runtime
# such as iOS-27-2-iPhone19-4 (iPhone Duo only). That last rule and the newest-
# version tie-break match scripts/ios/prototype-agent-smoke.sh and
# scripts/ios/prototype-mcp-smoke-lane.sh.
#
# Side-effect free and safe to source. Callers run jq themselves, e.g.
#   jq -r --arg v "26.6" "${IOS_SIM_COUNT_MATCHING_RUNTIMES_JQ}" <<< "${runtimes_json}"
# so no helper function runs inside a command substitution (SC2311).
#
# Versions are compared numerically, component by component. A "major.minor"
# argument matches a runtime whose version is exactly it or starts with it plus
# a dot, so "26.6" matches 26.6 and 26.6.1 but not 26.60.

IOS_SIM_JQ_DEFS='
def ver: split(".") | map(tonumber? // 0);
def usable_ios_runtime:
  select(.identifier | test("\\.SimRuntime\\.iOS-"))
  | select(.isAvailable != false)
  | select(.supportedArchitectures == null or (.supportedArchitectures | length) > 0)
  | select(.identifier | test("\\.iOS-[0-9-]+-[A-Za-z]") | not)
  | select(.supportedDeviceTypes == null
      or any(.supportedDeviceTypes[]; .productFamily == "iPhone" and ((.name // "") | test("Duo") | not)));
def matches_major_minor($v): .version == $v or (.version | startswith($v + "."));
'

# --arg v MAJOR.MINOR -> number of usable runtimes matching it.
IOS_SIM_COUNT_MATCHING_RUNTIMES_JQ="${IOS_SIM_JQ_DEFS}"'
[.runtimes[] | usable_ios_runtime | select(matches_major_minor($v))] | length
'

# --arg v SDK_MAJOR.MINOR --arg min DEPLOYMENT_TARGET -> "version<TAB>identifier"
# of the newest usable runtime matching the SDK; else the newest usable runtime
# between the deployment target and the SDK (a newer runtime than the SDK cannot
# run this Xcode's builds); else nothing.
IOS_SIM_PICK_RUNTIME_JQ="${IOS_SIM_JQ_DEFS}"'
[.runtimes[] | usable_ios_runtime] as $usable
| ([$usable[] | select(matches_major_minor($v))] | sort_by(.version | ver) | last)
  // ([$usable[] | select((.version | ver) >= ($min | ver) and (.version | ver) <= ($v | ver))]
      | sort_by(.version | ver) | last)
| select(. != null)
| [.version, .identifier] | @tsv
'

# --argjson runtimes RUNTIMES_JSON --arg v SDK_MAJOR.MINOR --arg min DEPLOYMENT_TARGET
# --arg runtime RUNTIME_ID, input DEVICES_JSON -> "udid<TAB>name".
# Prefers a booted iPhone on any usable runtime in [min, SDK], then an available
# iPhone on RUNTIME_ID. Default-named simulators ("iPhone ...") win over custom
# names (which on a shared host may belong to another tool), then the newest
# device generation.
IOS_SIM_PICK_SIMULATOR_JQ="${IOS_SIM_JQ_DEFS}"'
def gen: [(.deviceTypeIdentifier // "") | match("iPhone-([0-9]+)") | .captures[0].string | tonumber][0] // 0;
def rank: [(if (.name | startswith("iPhone")) then 1 else 0 end), gen, .name];
[$runtimes.runtimes[] | usable_ios_runtime
  | select((.version | ver) >= ($min | ver) and (.version | ver) <= ($v | ver))
  | .identifier] as $in_range
| [.devices | to_entries[] | .key as $rt | .value[]
    | select(.isAvailable != false)
    | select((.deviceTypeIdentifier // "") | test("\\.iPhone-"))
    | . + {runtime: $rt}] as $iphones
| ([$iphones[] | select(.state == "Booted" and (.runtime as $r | any($in_range[]; . == $r)))]
    | sort_by(rank) | last)
  // ([$iphones[] | select(.runtime == $runtime)] | sort_by(rank) | last)
| select(. != null)
| [.udid, .name] | @tsv
'

# --arg runtime RUNTIME_ID, input RUNTIMES_JSON -> identifier of the newest
# iPhone device type that runtime supports (same choice as the smoke lanes).
IOS_SIM_PICK_IPHONE_DEVICE_TYPE_JQ='
[.runtimes[] | select(.identifier == $runtime) | (.supportedDeviceTypes // [])[]
  | select(.productFamily == "iPhone")
  | . + {gen: ([(.name // "") | match("iPhone ([0-9]+)") | .captures[0].string | tonumber][0] // 0)}]
| sort_by(.gen) | last // empty | .identifier
'

# Under CI the shared host runs other jobs' simulators, so a job never adopts an
# arbitrary booted or existing one. It uses one dedicated simulator, found by
# exact name on RUNTIME_ID (else created by the caller).
IOS_SIM_CI_NAME="AutoMobile Playground CI"

# --arg runtime RUNTIME_ID --arg name NAME, input DEVICES_JSON -> "udid<TAB>name"
# of the available simulator with exactly that name on that runtime.
IOS_SIM_PICK_NAMED_JQ='
[.devices[$runtime] // [] | .[] | select(.isAvailable != false and .name == $name)]
| first // empty | [.udid, .name] | @tsv
'
