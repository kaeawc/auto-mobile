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
  HOME="$BATS_TEST_TMPDIR/home"
  export HOME
  mkdir -p "$STUB_DIR" "$PREFIX" "$HOME"
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
# Builds a fake archive, stubs curl to deliver it, and exports the digest the
# installer should expect. Without a real payload the installer's sha256
# verification would reject every stubbed download.
stub_download() {
  local installed_version="$1"
  ARCHIVE="$BATS_TEST_TMPDIR/fake-xcodegen.zip"
  printf 'fake xcodegen archive %s' "$installed_version" > "$ARCHIVE"
  if command -v shasum >/dev/null 2>&1; then
    ARCHIVE_SHA="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  else
    ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  fi
  cat > "$STUB_DIR/curl" <<EOF
#!/bin/bash
for arg in "\$@"; do echo "\$arg"; done >> "$STUB_DIR/curl.log"
out=""; prev=""
for a in "\$@"; do [[ "\$prev" == "-o" ]] && out="\$a"; prev="\$a"; done
cp "$ARCHIVE" "\$out"
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
  run env PATH="$STUB_DIR:/usr/bin:/bin" XCODEGEN_PREFIX="$PREFIX" \
      XCODEGEN_RELEASE_SHA256="${ARCHIVE_SHA:-}" bash "$SCRIPT"
}

@test "no-ops when the pinned version is already installed" {
  # Model a COMPLETE install: the fast path requires share/xcodegen next to the
  # binary, so that an install interrupted between the two copies is repaired
  # rather than reported as already done.
  mkdir -p "$PREFIX/bin" "$PREFIX/share/xcodegen"
  cat > "$PREFIX/bin/xcodegen" <<'EOF'
#!/bin/bash
echo "Version: 2.46.0"
EOF
  chmod +x "$PREFIX/bin/xcodegen"
  stub_download "2.46.0"

  run env PATH="$PREFIX/bin:$STUB_DIR:/usr/bin:/bin" XCODEGEN_PREFIX="$PREFIX" \
      XCODEGEN_RELEASE_SHA256="$ARCHIVE_SHA" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"already installed"* ]]
  # Must not download anything on the happy path.
  [ ! -f "$STUB_DIR/curl.log" ]
}

@test "repairs an install whose share/ directory is missing" {
  # The sticky-partial-install case: a version-only fast path would report
  # "already installed" forever and never restore the templates.
  mkdir -p "$PREFIX/bin"
  cat > "$PREFIX/bin/xcodegen" <<'EOF'
#!/bin/bash
echo "Version: 2.46.0"
EOF
  chmod +x "$PREFIX/bin/xcodegen"
  stub_download "2.46.0"

  run env PATH="$PREFIX/bin:$STUB_DIR:/usr/bin:/bin" XCODEGEN_PREFIX="$PREFIX" \
      XCODEGEN_RELEASE_SHA256="$ARCHIVE_SHA" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" != *"already installed"* ]]
  [ -d "$PREFIX/share/xcodegen" ]
}

@test "installs the pinned version when xcodegen is absent" {
  stub_download "2.46.0"
  run_installer
  [ "$status" -eq 0 ]
  [ -x "$PREFIX/bin/xcodegen" ]
  [ -d "$PREFIX/share/xcodegen" ]
}

@test "falls back when the bin directory is writable but share is not" {
  # CircleCI allows writing /usr/local/bin but not /usr/local/share. The
  # generator's templates must live under share/, so prefix writability covers
  # both locations before the installer chooses it.
  local fallback_home="$BATS_TEST_TMPDIR/home"
  mkdir -p "$PREFIX/bin" "$fallback_home"
  cat > "$STUB_DIR/mkdir" <<EOF
#!/bin/bash
for arg in "\$@"; do
  if [[ "\$arg" == "${PREFIX}/share" ]]; then
    echo "mkdir: ${PREFIX}/share: Permission denied" >&2
    exit 1
  fi
done
exec /bin/mkdir "\$@"
EOF
  chmod +x "$STUB_DIR/mkdir"
  stub_download "2.46.0"

  run env PATH="$STUB_DIR:/usr/bin:/bin" HOME="$fallback_home" XCODEGEN_PREFIX="$PREFIX" \
      XCODEGEN_RELEASE_SHA256="$ARCHIVE_SHA" bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [ -x "$fallback_home/.local/bin/xcodegen" ]
  [ -d "$fallback_home/.local/share/xcodegen" ]
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
      XCODEGEN_RELEASE_SHA256="$ARCHIVE_SHA" GITHUB_PATH="$ghpath" bash "$SCRIPT"
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

@test "the archive digest is pinned alongside the version" {
  # The version alone is not enough: GitHub release assets are mutable, so a
  # re-uploaded xcodegen.zip under the same tag would still report the pinned
  # version and pass the gate while generating different bytes — #3975 with the
  # guard green. The digest is what makes the pin actually byte-exact.
  source "$VERSION_FILE"
  [[ "$XCODEGEN_RELEASE_URL" == *"/${XCODEGEN_VERSION}/"* ]]
  [[ "$XCODEGEN_RELEASE_SHA256" =~ ^[0-9a-f]{64}$ ]]
}

@test "the installer verifies the digest before installing" {
  # Guards against the verification being dropped in a future refactor: a
  # tampered archive must not reach the destination prefix.
  grep -q "XCODEGEN_RELEASE_SHA256" "$SCRIPT"
  grep -qE "shasum -a 256|sha256sum" "$SCRIPT"
}

@test "rejects an archive whose digest does not match the pin" {
  stub_download "2.46.0"
  # Make the fabricated archive's bytes differ from the pinned digest by
  # letting the real verification run against stubbed content.
  cat > "$STUB_DIR/curl" <<EOF
#!/bin/bash
out=""; prev=""
for a in "\$@"; do [[ "\$prev" == "-o" ]] && out="\$a"; prev="\$a"; done
printf 'not the real archive' > "\$out"
EOF
  chmod +x "$STUB_DIR/curl"
  # Deliberately expect the real pin while curl delivers different bytes.
  run env PATH="$STUB_DIR:/usr/bin:/bin" XCODEGEN_PREFIX="$PREFIX" bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"digest mismatch"* ]]
  [ ! -e "$PREFIX/bin/xcodegen" ]
}
