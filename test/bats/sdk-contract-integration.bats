#!/usr/bin/env bats

setup_file() {
  export TEST_ROOT="${BATS_FILE_TMPDIR}/repo"
  mkdir -p "${TEST_ROOT}/scripts/ios"
  cp "${BATS_TEST_DIRNAME}/../../scripts/ios/sdk-contract-integration.sh" "${TEST_ROOT}/scripts/ios/"
}

setup() {
  export INVOCATION_FILE="${BATS_TEST_TMPDIR}/invocations"
  SCRIPT="${TEST_ROOT}/scripts/ios/sdk-contract-integration.sh"
  DEVICE="12345678-1234-1234-1234-123456789abc"
  REPORT="${BATS_TEST_TMPDIR}/report.json"
  export AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA="${BATS_TEST_TMPDIR}/runner derived data"
  unset AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD

  xcodebuild() {
    printf 'playground:%s\n' "$*" >> "$INVOCATION_FILE"
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '-derivedDataPath' ]; then
        mkdir -p "$2/Build/Products/Debug-iphonesimulator/Playground.app"
        return 0
      fi
      shift
    done
    return 1
  }
  xcrun() {
    printf 'xcrun:%s\n' "$*" >> "$INVOCATION_FILE"
  }
  bun() {
    printf 'bun:%s\n' "$@" >> "$INVOCATION_FILE"
  }
  export -f xcodebuild xcrun bun
}

@test "requires AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true before any work" {
  run bash "$SCRIPT" "$DEVICE" "$REPORT"
  echo "status=$status output=$output"
  [ "$status" -eq 2 ]
  [[ "$output" == *"AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD"* ]]
  [[ "$output" == *"source "*"/daemon1/env.sh"* ]]
  [ ! -e "$INVOCATION_FILE" ]
}

@test "requires an explicit runner derived-data path" {
  export AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true
  unset AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA
  run bash "$SCRIPT" "$DEVICE" "$REPORT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA"* ]]
  [ ! -e "$INVOCATION_FILE" ]
}

@test "rejects local-build values other than exactly true" {
  export AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=TRUE
  run bash "$SCRIPT" "$DEVICE" "$REPORT"
  [ "$status" -eq 2 ]
  [ ! -e "$INVOCATION_FILE" ]
}

@test "requires prebuilt runner products before any build or suite invocation" {
  export AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true
  run bash "$SCRIPT" "$DEVICE" "$REPORT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"${AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA}/Build/Products/Debug-iphonesimulator/AutoMobileTest.app"* ]]
  [[ "$output" == *"bash scripts/ios/ctrl-proxy-build-for-testing.sh using the same AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA, then start the private daemon"*"then rerun"* ]]
  [ ! -e "$INVOCATION_FILE" ]
}

@test "uses the prebuilt runner and builds Playground before invoking the contract suite" {
  export AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true
  mkdir -p "${AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA}/Build/Products/Debug-iphonesimulator/AutoMobileTest.app"
  run bash "$SCRIPT" "$DEVICE" "$REPORT"
  [ "$status" -eq 0 ]
  calls="$(< "$INVOCATION_FILE")"
  [[ "$calls" == "xcrun:"*"playground:"*"bun:scripts/ios/sdk-contract/run.ts"* ]]
  [[ "$calls" == *"-project ${TEST_ROOT}/ios/Playground/Playground.xcodeproj -scheme Playground -configuration Debug"* ]]
  [[ "$calls" == *"xcrun:simctl bootstatus ${DEVICE} -b"* ]]
  [[ "$calls" == *$'bun:--device\nbun:'"${DEVICE}"* ]]
  [[ "$calls" == *$'bun:--app\nbun:'*"/Build/Products/Debug-iphonesimulator/Playground.app"* ]]
  [[ "$calls" == *$'bun:--report\nbun:'"${REPORT}"* ]]
}
