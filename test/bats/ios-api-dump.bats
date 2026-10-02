#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ios/api-dump.sh"
  FIXTURES="$REPO_ROOT/test/fixtures/ios-api-dump"
  export AUTOMOBILE_IOS_API_SOURCES="$BATS_TEST_TMPDIR/sources"
  export AUTOMOBILE_IOS_API_FILE="$BATS_TEST_TMPDIR/baseline.api"
  mkdir -p "$AUTOMOBILE_IOS_API_SOURCES"
  cp "$FIXTURES/surface/Surface.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
}

@test "renaming a public enum case fails the API check" {
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  sed 's/case success/case renamedSuccess/' "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift" > "$BATS_TEST_TMPDIR/changed.swift"
  mv "$BATS_TEST_TMPDIR/changed.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  run bash "$SCRIPT" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'-  case success'* ]]
  [[ "$output" == *'+  case renamedSuccess'* ]]
}

@test "renaming a public protocol requirement fails the API check" {
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  sed 's/captureObservation/renamedObservation/' "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift" > "$BATS_TEST_TMPDIR/changed.swift"
  mv "$BATS_TEST_TMPDIR/changed.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  run bash "$SCRIPT" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'-  func captureObservation() -> Value'* ]]
  [[ "$output" == *'+  func renamedObservation() -> Value'* ]]
}

@test "public enum cases include indirect associated and nested cases but exclude hidden scopes" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *'  case failure, cancelled'* ]]
  [[ "$output" == *'  case value( code: Int, message: String )'* ]]
  [[ "$output" == *'  indirect case next(Result)'* ]]
  [[ "$output" == *'  case leaf'* ]]
  [[ "$output" == *$'\npublic indirect enum Tree\n'* ]]
  [[ "$output" == *'  case branch(Tree, Tree)'* ]]
  [[ "$output" == *'  case nestedPublic'* ]]
  [[ "$output" == *'  case followingPublic'* ]]
  [[ "$output" == *'  case afterBody'* ]]
  [[ "$output" != *'case internalOnly'* ]]
  [[ "$output" != *'case privateOnly'* ]]
  [[ "$output" != *'case fileprivateOnly'* ]]
  [[ "$output" != *'case explicitInternalOnly'* ]]
  [[ "$output" != *'case nestedPrivate'* ]]
  [[ "$output" != *'case hiddenParent'* ]]
  [[ "$output" != *'case privateParent'* ]]
  [[ "$output" != *'case .success'* ]]
  [ "$(printf '%s\n' "$output" | grep -c '^  public var name: String$')" -eq 1 ]
}

@test "protocol requirements include attributes and accessors without recording accessor continuations" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *'  associatedtype Value'* ]]
  [[ "$output" == *'  var value: Value'* ]]
  [[ "$output" == *'  var splitAccessors: Value'* ]]
  [[ "$output" == *'  init( value: Value )'* ]]
  [[ "$output" == *'  subscript(index: Int) -> Value'* ]]
  [[ "$output" == *'  static func make() -> Self'* ]]
  [[ "$output" == *'  static var count: Int'* ]]
  [[ "$output" == *'  class func classRequirement() -> Self'* ]]
  [[ "$output" == *'  @objc optional func optionalRequirement()'* ]]
  [[ "$output" == *'  @MainActor func attributedRequirement()'* ]]
  [[ "$output" == *'  func nextLineAttribute()'* ]]
  [[ "$output" == *'  func conditionalRequirement()'* ]]
  [[ "$output" == *'  func afterComment()'* ]]
  [[ "$output" != *'  get'* ]]
  [[ "$output" != *'  set'* ]]
  [[ "$output" != *'commentedRequirement'* ]]
  [[ "$output" != *'internalRequirement'* ]]
  [[ "$output" != *'defaultImplementation'* ]]
}

@test "public extensions inherit public access without exposing private members or function bodies" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *'  func inherited()'* ]]
  [[ "$output" == *'  @MainActor func attributedMember()'* ]]
  [[ "$output" == *'  var inheritedValue: Int'* ]]
  [[ "$output" == *'  init(value: Int)'* ]]
  [[ "$output" == *'  static func inheritedStatic()'* ]]
  [[ "$output" == *'  class func inheritedClass()'* ]]
  [[ "$output" == *'  enum InheritedEnum'* ]]
  [[ "$output" == *'  case extensionCase'* ]]
  [[ "$output" != *'privateMember'* ]]
  [[ "$output" != *'fileprivateMember'* ]]
  [[ "$output" != *'internalMember'* ]]
  [[ "$output" != *'let local'* ]]
  [[ "$output" != *'implementationLocal'* ]]
  [[ "$output" != *'case "}"'* ]]
  [ "$(printf '%s\n' "$output" | grep -c '^  public func explicitPublic()$')" -eq 1 ]
}

@test "renaming an implicit public extension member fails the API check" {
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  sed 's/func inherited()/func renamedInherited()/' "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift" > "$BATS_TEST_TMPDIR/changed.swift"
  mv "$BATS_TEST_TMPDIR/changed.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  run bash "$SCRIPT" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'-  func inherited()'* ]]
  [[ "$output" == *'+  func renamedInherited()'* ]]
}

@test "two dumps of the same fixtures are byte identical and sorted by file" {
  cp "$FIXTURES/legacy/Legacy.swift" "$AUTOMOBILE_IOS_API_SOURCES/AAA.swift"
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  bash "$SCRIPT" > "$BATS_TEST_TMPDIR/second.api"
  cmp "$AUTOMOBILE_IOS_API_FILE" "$BATS_TEST_TMPDIR/second.api"
  [ "$(head -n 1 "$AUTOMOBILE_IOS_API_FILE")" = '// AAA.swift' ]
  run bash "$SCRIPT" --check
  [ "$status" -eq 0 ]
}

@test "existing public declarations retain their exact formatting and closure defaults" {
  export AUTOMOBILE_IOS_API_SOURCES="$FIXTURES/legacy"
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  diff -u "$FIXTURES/legacy.api" "$AUTOMOBILE_IOS_API_FILE"
}

@test "the system bash produces the same fixture baseline without diagnostics" {
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  # macOS /bin/bash is 3.2; Linux also exercises the system interpreter.
  run /bin/bash "$SCRIPT" --check
  [ "$status" -eq 0 ]
  [ "$output" = 'iOS API surface is up to date.' ]
}

@test "the real SDK baseline is current and contains biometric cases and the observation requirement" {
  unset AUTOMOBILE_IOS_API_SOURCES AUTOMOBILE_IOS_API_FILE
  run bash "$SCRIPT" --check
  [ "$status" -eq 0 ]
  local baseline="$REPO_ROOT/ios/auto-mobile-sdk/api/auto-mobile-sdk.api"
  grep -A 4 '^public enum BiometricResult:' "$baseline" > "$BATS_TEST_TMPDIR/biometric.api"
  grep -Fx '  case success' "$BATS_TEST_TMPDIR/biometric.api"
  grep -Fx '  case failure' "$BATS_TEST_TMPDIR/biometric.api"
  grep -Fx '  case cancel' "$BATS_TEST_TMPDIR/biometric.api"
  grep -Fx '  case error(code: Int, message: String)' "$BATS_TEST_TMPDIR/biometric.api"
  grep -A 1 '^public protocol AutoMobileObservationProvider:' "$baseline" | grep -Fx '  func captureObservation() async -> AutoMobileObservationSnapshot'
}
