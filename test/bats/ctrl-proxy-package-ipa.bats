#!/usr/bin/env bats

setup() {
  TEST_ROOT="$(mktemp -d)"
  SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/ios/ctrl-proxy-package-ipa.sh"
  BUILD_DIR="${TEST_ROOT}/Derived Data/Build"
  PRODUCTS="${BUILD_DIR}/Products"
  SIM_DIR="${PRODUCTS}/Debug-iphonesimulator"
  OUTPUT_PATH="${TEST_ROOT}/archives/control proxy.ipa"
  UNPACKED="${TEST_ROOT}/unpacked"
  unset CTRL_PROXY_IPA_FULL_DEBUG

  local config module bundle
  for config in Debug-iphonesimulator Release-iphonesimulator; do
    mkdir -p "${PRODUCTS}/${config}"
    printf 'build object\n' > "${PRODUCTS}/${config}/AutoMobileSdkWire.o"
    for module in AutoMobileSdkWire AutoMobileTest CtrlProxyUITests; do
      mkdir -p "${PRODUCTS}/${config}/${module}.swiftmodule/Project"
      printf 'compiled module\n' > "${PRODUCTS}/${config}/${module}.swiftmodule/arm64.swiftmodule"
      printf 'source info\n' > "${PRODUCTS}/${config}/${module}.swiftmodule/Project/arm64.swiftsourceinfo"
    done
  done

  for bundle in AutoMobileTest.app CtrlProxyUITests-Runner.app ObjCExceptionCatcher.framework PackageFrameworks/Dependency.framework; do
    mkdir -p "${SIM_DIR}/${bundle}/Resources/Nested.swiftmodule/Project"
    printf 'runtime bundle\n' > "${SIM_DIR}/${bundle}/Info.plist"
    printf 'nested object\n' > "${SIM_DIR}/${bundle}/foo.o"
    printf 'nested source info\n' > "${SIM_DIR}/${bundle}/Resources/Nested.swiftmodule/Project/arm64.swiftsourceinfo"
  done
  mkdir -p "${SIM_DIR}/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest"
  printf 'runner executable\n' > "${SIM_DIR}/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests"
  printf 'test bundle object\n' > "${SIM_DIR}/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/foo.o"
  printf 'test plan\n' > "${PRODUCTS}/AutoMobileTest_iphonesimulator.xctestrun"
  # Similar names outside the configuration-entry boundary must survive.
  printf 'products-root object\n' > "${PRODUCTS}/root.o"
  mkdir -p "${PRODUCTS}/Root.swiftmodule" "${SIM_DIR}/directory.o"
  printf 'products-root module\n' > "${PRODUCTS}/Root.swiftmodule/arm64.swiftmodule"
  printf 'directory named like object\n' > "${SIM_DIR}/directory.o/keep"
  printf 'file named like module\n' > "${SIM_DIR}/file.swiftmodule"
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

unpack_archive() {
  run unzip -q "$OUTPUT_PATH" -d "$UNPACKED"
  [ "$status" -eq 0 ]
}

assert_runtime_archive() {
  local config module bundle
  for config in Debug-iphonesimulator Release-iphonesimulator; do
    [ ! -e "${UNPACKED}/Build/Products/${config}/AutoMobileSdkWire.o" ]
    for module in AutoMobileSdkWire AutoMobileTest CtrlProxyUITests; do
      [ ! -e "${UNPACKED}/Build/Products/${config}/${module}.swiftmodule" ]
      # Filtering must leave the original build products intact.
      [ -f "${PRODUCTS}/${config}/${module}.swiftmodule/Project/arm64.swiftsourceinfo" ]
    done
    [ -f "${PRODUCTS}/${config}/AutoMobileSdkWire.o" ]
  done
  for bundle in AutoMobileTest.app CtrlProxyUITests-Runner.app ObjCExceptionCatcher.framework PackageFrameworks; do
    run diff -r "${SIM_DIR}/${bundle}" "${UNPACKED}/Build/Products/Debug-iphonesimulator/${bundle}"
    [ "$status" -eq 0 ]
  done
  run cmp "${PRODUCTS}/AutoMobileTest_iphonesimulator.xctestrun" "${UNPACKED}/Build/Products/AutoMobileTest_iphonesimulator.xctestrun"
  [ "$status" -eq 0 ]
  [ -f "${UNPACKED}/Build/Products/root.o" ]
  [ -f "${UNPACKED}/Build/Products/Root.swiftmodule/arm64.swiftmodule" ]
  [ -f "${UNPACKED}/Build/Products/Debug-iphonesimulator/directory.o/keep" ]
  [ -f "${UNPACKED}/Build/Products/Debug-iphonesimulator/file.swiftmodule" ]
}

@test "default excludes only configuration-level build objects and module directories" {
  run bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -eq 0 ]
  unpack_archive
  assert_runtime_archive
}

@test "full-debug flag preserves the complete Products tree" {
  run bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH" --full-debug
  [ "$status" -eq 0 ]
  unpack_archive
  run diff -r "$PRODUCTS" "${UNPACKED}/Build/Products"
  [ "$status" -eq 0 ]
}

@test "full-debug environment variable preserves the complete Products tree" {
  run env CTRL_PROXY_IPA_FULL_DEBUG=1 bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -eq 0 ]
  unpack_archive
  run diff -r "$PRODUCTS" "${UNPACKED}/Build/Products"
  [ "$status" -eq 0 ]
}

@test "default replaces an existing full-debug archive without stale entries" {
  run bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH" --full-debug
  [ "$status" -eq 0 ]
  run bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -eq 0 ]
  unpack_archive
  assert_runtime_archive
}

@test "packaging supports relative input and output paths" {
  cd "$TEST_ROOT"
  run bash "$SCRIPT" --products 'Derived Data/Build' --output 'archives/control proxy.ipa'
  [ "$status" -eq 0 ]
  unpack_archive
  assert_runtime_archive
}

@test "full-debug flag enables full mode even when environment is zero" {
  run env CTRL_PROXY_IPA_FULL_DEBUG=0 bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH" --full-debug
  [ "$status" -eq 0 ]
  unpack_archive
  run diff -r "$PRODUCTS" "${UNPACKED}/Build/Products"
  [ "$status" -eq 0 ]
}

@test "missing option values fail with usage" {
  run bash "$SCRIPT" --products
  [ "$status" -ne 0 ]
  [[ "$output" == *"Usage:"* ]]
  run bash "$SCRIPT" --products "$BUILD_DIR" --output
  [ "$status" -ne 0 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "missing Products directory fails without replacing the output" {
  mkdir -p "$(dirname "$OUTPUT_PATH")"
  printf 'existing archive\n' > "$OUTPUT_PATH"
  run bash "$SCRIPT" --products "${TEST_ROOT}/missing" --output "$OUTPUT_PATH"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Products directory not found:"* ]]
  [ "$(cat "$OUTPUT_PATH")" = 'existing archive' ]
}
