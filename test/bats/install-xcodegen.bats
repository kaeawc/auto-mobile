#!/usr/bin/env bats
#
# Tests for scripts/ios/install-xcodegen.sh and scripts/ios/xcodegen_version.sh
#
# Regression guard for #3975: CI ran a bare `brew install xcodegen`, which
# resolved against the runner image's stale formula index and installed 2.45.4
# while contributors had 2.46.0. The two versions order the PBXProject `targets`
# array differently, so every PR failed the drift check with an ordering-only
# diff that looked like a stale project file rather than a toolchain skew.
#
# `curl`, `unzip` and `xcodegen` are stubbed on PATH so these never hit the
# network and never touch a real install.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ios/install-xcodegen.sh"
  VERSION_FILE="$REPO_ROOT/scripts/ios/xcodegen_version.sh"
  STUB_DIR="$BATS_TEST_TMPDIR/stubs"
  PREFIX="$BATS_TEST_TMPDIR/prefix"
  mkdir -p "$STUB_DIR" "$PREFIX"
}

# Fake xcodegen on PATH reporting $1.
stub_xcodegen() {
  cat > "$STUB_DIR/xcodegen" <<EOF
#!/bin/bash
echo "Version: $1"
EOF
  chmod +x "$STUB_DIR/xcodegen"
}

# curl/unzip stubs that fabricate the archive layout the installer expects,
# recording the requested URL so tests can assert the pin is in it.
stub_download() {
  local installed_version="$1"
  cat > "$STUB_DIR/curl" <<EOF
#!/bin/bash
for arg in "\$@"; do echo "\$arg"; done >> "$STUB_DIR/curl.log"
EOF
  cat > "$STUB_DIR/unzip" <<EOF
#!/bin/bash
# Last arg is the destination dir (invoked as: unzip -qq -o <zip> -d <dir>)
dest="\${!#}"
mkdir -p "\$dest/xcodegen/bin" "\$dest/xcodegen/share/xcodegen"
cat > "\$dest/xcodegen/bin/xcodegen" <<INNER
#!/bin/bash
echo "Version: $installed_version"
INNER
chmod +x "\$dest/xcodegen/bin/xcodegen"
EOF
  chmod +x "$STUB_DIR/curl" "$STUB_DIR/unzip"
}

run_installer() {
  run env PATH="$STUB_DIR:/usr/bin:/bin" XCODEGEN_PREFIX="$PREFIX" bash "$SCRIPT"
}

@test "no-ops when the pinned version is already installed" {
  stub_xcodegen "2.46.0"
  stub_download "2.46.0"
  run_installer
  [ "$status" -eq 0 ]
  [[ "$output" == *"already installed"* ]]
  # Must not download anything on the happy path.
  [ ! -f "$STUB_DIR/curl.log" ]
}

@test "installs the pinned version when xcodegen is absent" {
  stub_download "2.46.0"
  run_installer
  [ "$status" -eq 0 ]
  [ -x "$PREFIX/bin/xcodegen" ]
  [ -d "$PREFIX/share/xcodegen" ]
}

@test "replaces a skewed version — the #3975 shape" {
  stub_xcodegen "2.45.4"
  stub_download "2.46.0"
  run_installer
  [ "$status" -eq 0 ]
  [[ "$output" == *"found '2.45.4'"* ]]
  [ -x "$PREFIX/bin/xcodegen" ]
}

@test "downloads the pinned version by URL, so it cannot drift" {
  stub_download "2.46.0"
  run_installer
  grep -q "releases/download/2.46.0/xcodegen.zip" "$STUB_DIR/curl.log"
}

@test "fails loudly if the installed binary is not the pinned version" {
  # Archive contains the wrong build: the post-install gate must catch it
  # rather than let a skewed generator write project files.
  stub_download "2.45.4"
  run_installer
  [ "$status" -eq 1 ]
  [[ "$output" == *"version mismatch"* ]]
  [[ "$output" == *"2.46.0"* ]]
}

@test "appends to GITHUB_PATH so later CI steps see the pinned binary" {
  stub_download "2.46.0"
  local ghpath="$BATS_TEST_TMPDIR/github_path"
  : > "$ghpath"
  run env PATH="$STUB_DIR:/usr/bin:/bin" XCODEGEN_PREFIX="$PREFIX" \
      GITHUB_PATH="$ghpath" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q "$PREFIX/bin" "$ghpath"
}

@test "require_pinned_xcodegen_version rejects a skewed generator" {
  stub_xcodegen "2.45.4"
  run env PATH="$STUB_DIR:/usr/bin:/bin" bash -c \
    "source '$VERSION_FILE'; require_pinned_xcodegen_version; echo SHOULD_NOT_REACH"
  [ "$status" -eq 1 ]
  [[ "$output" != *"SHOULD_NOT_REACH"* ]]
  [[ "$output" == *"2.45.4"* ]]
  [[ "$output" == *"2.46.0"* ]]
}

@test "require_pinned_xcodegen_version accepts the pinned generator" {
  stub_xcodegen "2.46.0"
  run env PATH="$STUB_DIR:/usr/bin:/bin" bash -c \
    "source '$VERSION_FILE'; require_pinned_xcodegen_version; echo OK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK"* ]]
}

@test "the pin matches the version that generated the committed project" {
  # A bump without regenerating turns every PR red, so tie the pin to the
  # committed pbxproj rather than asserting the literal against itself.
  source "$VERSION_FILE"
  run grep -q "objectVersion" "$REPO_ROOT/ios/control-proxy/CtrlProxy.xcodeproj/project.pbxproj"
  [ "$status" -eq 0 ]
  [ -n "$XCODEGEN_VERSION" ]
  [[ "$XCODEGEN_RELEASE_URL" == *"/${XCODEGEN_VERSION}/"* ]]
}
