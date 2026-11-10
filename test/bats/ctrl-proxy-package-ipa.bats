#!/usr/bin/env bats

setup() {
  bats_require_minimum_version 1.5.0
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

@test "absolute Products symlink is staged as a copy and the source tree is untouched" {
  local real_products="${TEST_ROOT}/real-products"
  local link_build="${TEST_ROOT}/Linked/Build"
  mv "$PRODUCTS" "$real_products"
  mkdir -p "$link_build"
  ln -s "$real_products" "${link_build}/Products"
  local before
  before="$(cd "$real_products" && find . | LC_ALL=C sort)"

  run bash "$SCRIPT" --products "$link_build" --output "$OUTPUT_PATH"
  [ "$status" -eq 0 ]

  [ "$(cd "$real_products" && find . | LC_ALL=C sort)" = "$before" ]
  [ -f "${real_products}/Debug-iphonesimulator/AutoMobileSdkWire.o" ]
  [ -d "${real_products}/Debug-iphonesimulator/AutoMobileTest.swiftmodule" ]
  unpack_archive
  [ ! -L "${UNPACKED}/Build/Products" ]
  [ -d "${UNPACKED}/Build/Products/Debug-iphonesimulator/AutoMobileTest.app" ]
  [ ! -e "${UNPACKED}/Build/Products/Debug-iphonesimulator/AutoMobileSdkWire.o" ]
  [ ! -e "${UNPACKED}/Build/Products/Debug-iphonesimulator/AutoMobileTest.swiftmodule" ]
}

seed_existing_archive() {
  mkdir -p "$(dirname "$OUTPUT_PATH")"
  printf 'existing archive\000must survive\n' > "$OUTPUT_PATH"
  cp "$OUTPUT_PATH" "${TEST_ROOT}/original.ipa"
}

assert_only_output_archive() {
  local entries
  entries="$(find "$(dirname "$OUTPUT_PATH")" -mindepth 1)"
  [ "$entries" = "$OUTPUT_PATH" ]
}

@test "dangling staged framework links list every offender on stderr and preserve the output" {
  seed_existing_archive
  printf 'outside Products\n' > "${TEST_ROOT}/outside-file"
  local framework="${SIM_DIR}/ObjCExceptionCatcher.framework"
  ln -s ../../../../../outside-file "${framework}/outside link"
  ln -s missing-target "${framework}/missing link"
  [ -e "${framework}/outside link" ]

  run --separate-stderr bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"Dangling symlink in staged Products: Debug-iphonesimulator/ObjCExceptionCatcher.framework/outside link -> ../../../../../outside-file"* ]]
  [[ "$stderr" == *"Dangling symlink in staged Products: Debug-iphonesimulator/ObjCExceptionCatcher.framework/missing link -> missing-target"* ]]
  cmp "$OUTPUT_PATH" "${TEST_ROOT}/original.ipa"
  assert_only_output_archive
}

@test "links made dangling by pruning are rejected before replacing the output" {
  seed_existing_archive
  ln -s ../AutoMobileSdkWire.o "${SIM_DIR}/ObjCExceptionCatcher.framework/debug-input"
  [ -e "${SIM_DIR}/ObjCExceptionCatcher.framework/debug-input" ]

  run --separate-stderr bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"Dangling symlink in staged Products: Debug-iphonesimulator/ObjCExceptionCatcher.framework/debug-input -> ../AutoMobileSdkWire.o"* ]]
  cmp "$OUTPUT_PATH" "${TEST_ROOT}/original.ipa"
  assert_only_output_archive
}

@test "framework Versions Current links still package with their target contents" {
  local framework="${SIM_DIR}/ObjCExceptionCatcher.framework"
  mkdir -p "${framework}/Versions/A/Resources"
  printf 'framework executable\n' > "${framework}/Versions/A/ObjCExceptionCatcher"
  printf 'framework resource\n' > "${framework}/Versions/A/Resources/fixture"
  ln -s A "${framework}/Versions/Current"
  ln -s Versions/Current/ObjCExceptionCatcher "${framework}/ObjCExceptionCatcher"

  run bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -eq 0 ]
  unpack_archive
  local unpacked_framework="${UNPACKED}/Build/Products/Debug-iphonesimulator/ObjCExceptionCatcher.framework"
  cmp "${framework}/Versions/A/ObjCExceptionCatcher" "${unpacked_framework}/ObjCExceptionCatcher"
  cmp "${framework}/Versions/A/Resources/fixture" "${unpacked_framework}/Versions/Current/Resources/fixture"
}

@test "zip failure preserves the existing archive and removes the partial archive" {
  seed_existing_archive
  local stub_dir="${TEST_ROOT}/bin"
  mkdir -p "$stub_dir"
  cat > "${stub_dir}/zip" <<'STUB'
#!/bin/bash
printf 'partial archive\n' > "$2"
exit 1
STUB
  chmod +x "${stub_dir}/zip"

  run --separate-stderr env PATH="${stub_dir}:$PATH" bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -eq 1 ]
  [[ "$stderr" == *"Failed to create IPA archive: zip exited with status 1"* ]]
  cmp "$OUTPUT_PATH" "${TEST_ROOT}/original.ipa"
  assert_only_output_archive
}

@test "unavailable zip preserves the existing archive and leaves no temporary archive" {
  seed_existing_archive
  local stub_dir="${TEST_ROOT}/bin"
  mkdir -p "$stub_dir"
  cat > "${stub_dir}/zip" <<'STUB'
#!/bin/bash
exit 127
STUB
  chmod +x "${stub_dir}/zip"

  run -127 --separate-stderr env PATH="${stub_dir}:$PATH" bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -eq 127 ]
  [[ "$stderr" == *"Failed to create IPA archive: zip exited with status 127"* ]]
  cmp "$OUTPUT_PATH" "${TEST_ROOT}/original.ipa"
  assert_only_output_archive
}

@test "successful packaging replaces the existing archive and leaves no temporary archive" {
  seed_existing_archive

  run bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -eq 0 ]
  run cmp "$OUTPUT_PATH" "${TEST_ROOT}/original.ipa"
  [ "$status" -ne 0 ]
  assert_only_output_archive
  unpack_archive
  assert_runtime_archive
}

@test "a link planted at the shared-directory temporary archive path is never written through" {
  seed_existing_archive
  local output_dir victim planted stub_dir real_mktemp real_zip entries
  output_dir="$(dirname "$OUTPUT_PATH")"
  victim="${TEST_ROOT}/victim"
  planted="${output_dir}/.$(basename "$OUTPUT_PATH").planted"
  printf 'victim contents\n' > "$victim"
  cp "$victim" "${TEST_ROOT}/victim.orig"
  ln -s "$victim" "$planted"

  # Make the former shared-directory temporary file path predictable and let a
  # zip wrapper re-plant the link there, as another user racing the script would.
  stub_dir="${TEST_ROOT}/bin"
  mkdir -p "$stub_dir"
  real_mktemp="$(command -v mktemp)"
  real_zip="$(command -v zip)"
  cat > "${stub_dir}/mktemp" <<STUB
#!/bin/bash
if [[ \$# -eq 1 && "\$1" == "${output_dir}/"* ]]; then
  printf '%s\n' "${planted}"
  exit 0
fi
exec "${real_mktemp}" "\$@"
STUB
  cat > "${stub_dir}/zip" <<STUB
#!/bin/bash
if [[ "\$(dirname "\$2")" == "${output_dir}" ]]; then
  ln -sfn "${victim}" "\$2"
fi
exec "${real_zip}" "\$@"
STUB
  chmod +x "${stub_dir}/mktemp" "${stub_dir}/zip"

  run env PATH="${stub_dir}:$PATH" bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -eq 0 ]
  cmp "$victim" "${TEST_ROOT}/victim.orig"
  [ -L "$planted" ]
  [ "$(readlink "$planted")" = "$victim" ]
  entries="$(find "$output_dir" -mindepth 1 | LC_ALL=C sort)"
  [ "$entries" = "$(printf '%s\n%s' "$planted" "$OUTPUT_PATH" | LC_ALL=C sort)" ]
  unpack_archive
  assert_runtime_archive
}

@test "the private temporary archive directory is not accessible to other users" {
  local stub_dir="${TEST_ROOT}/bin"
  mkdir -p "$stub_dir"
  cat > "${stub_dir}/zip" <<STUB
#!/bin/bash
stat -c '%a' "\$(dirname "\$2")" > "${TEST_ROOT}/archive-dir-mode" 2>/dev/null \
  || stat -f '%Lp' "\$(dirname "\$2")" > "${TEST_ROOT}/archive-dir-mode"
exit 1
STUB
  chmod +x "${stub_dir}/zip"

  run env PATH="${stub_dir}:$PATH" bash "$SCRIPT" --products "$BUILD_DIR" --output "$OUTPUT_PATH"
  [ "$status" -eq 1 ]
  [ "$(cat "${TEST_ROOT}/archive-dir-mode")" = 700 ]
  [ -z "$(find "$(dirname "$OUTPUT_PATH")" -mindepth 1)" ]
}
