#!/usr/bin/env bats
#
# Tests for normalize_pbxproj_targets in scripts/ios/pbxproj_normalize.sh
#
# Regression guard for #4080: XcodeGen 2.46.0 emits the PBXProject
# `targets = (...)` array in one of two environment-dependent orders for the
# same spec + pinned version (declaration order on some runners, alphabetical on
# others). The drift check reported each pure reorder as staleness, failing PRs
# nondeterministically. normalize_pbxproj_targets folds that one array's order
# out so a reorder compares equal while any real content change still differs.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  LIB="$REPO_ROOT/scripts/ios/pbxproj_normalize.sh"
  # shellcheck source=/dev/null
  source "$LIB"

  # The two orders XcodeGen actually alternates between (#4080). Same five
  # members, same UUIDs + comments, different order.
  DECLARATION_ORDER="$BATS_TEST_TMPDIR/decl.pbxproj"
  ALPHABETICAL_ORDER="$BATS_TEST_TMPDIR/alpha.pbxproj"

  cat > "$DECLARATION_ORDER" <<'EOF'
		projectRoot = "";
		targets = (
			829FFB06AC273BEE7049A7F2 /* CtrlProxyApp */,
			E35F925D729B7056D4E4B501 /* ObjCExceptionCatcher */,
			61A21F82A43E4D436CD13CCD /* CtrlProxy */,
			D665478F817F2DF283B43BFB /* CtrlProxyTests */,
			2B5458099134F47AA1A7C4DA /* CtrlProxyUITests */,
		);
	};
EOF

  cat > "$ALPHABETICAL_ORDER" <<'EOF'
		projectRoot = "";
		targets = (
			61A21F82A43E4D436CD13CCD /* CtrlProxy */,
			829FFB06AC273BEE7049A7F2 /* CtrlProxyApp */,
			D665478F817F2DF283B43BFB /* CtrlProxyTests */,
			2B5458099134F47AA1A7C4DA /* CtrlProxyUITests */,
			E35F925D729B7056D4E4B501 /* ObjCExceptionCatcher */,
		);
	};
EOF
}

@test "two target orderings of the same members normalize to identical output" {
  local a b
  a="$(normalize_pbxproj_targets < "$DECLARATION_ORDER")"
  b="$(normalize_pbxproj_targets < "$ALPHABETICAL_ORDER")"
  [ "$a" = "$b" ]
}

@test "normalization is idempotent" {
  local once twice
  once="$(normalize_pbxproj_targets < "$ALPHABETICAL_ORDER")"
  twice="$(printf '%s' "$once" | normalize_pbxproj_targets)"
  [ "$once" = "$twice" ]
}

@test "a real target change is NOT hidden by normalization" {
  local changed="$BATS_TEST_TMPDIR/changed.pbxproj"
  # Same order as declaration, but one target renamed -- a genuine content diff.
  sed 's/CtrlProxyTests/CtrlProxyRenamed/g' "$DECLARATION_ORDER" > "$changed"
  local base other
  base="$(normalize_pbxproj_targets < "$DECLARATION_ORDER")"
  other="$(normalize_pbxproj_targets < "$changed")"
  [ "$base" != "$other" ]
}

@test "lines outside the targets array are preserved verbatim and in place" {
  run normalize_pbxproj_targets < "$DECLARATION_ORDER"
  [ "$status" -eq 0 ]
  # First non-array line stays first; closing brace stays last.
  [ "${lines[0]}" = '		projectRoot = "";' ]
  [ "${lines[${#lines[@]}-1]}" = '	};' ]
}

@test "a non-targets array is left untouched (only 'targets' is normalized)" {
  local input="$BATS_TEST_TMPDIR/files.pbxproj"
  cat > "$input" <<'EOF'
		files = (
			ZZZ /* z */,
			AAA /* a */,
		);
EOF
  run normalize_pbxproj_targets < "$input"
  [ "$status" -eq 0 ]
  # Order of the files array must be unchanged (ZZZ still before AAA).
  [ "${lines[1]}" = '			ZZZ /* z */,' ]
  [ "${lines[2]}" = '			AAA /* a */,' ]
}
