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
  printf '%s\n' "$output" | grep -Fx '  var value: Value { get set }'
  printf '%s\n' "$output" | grep -Fx '  var splitAccessors: Value'
  [[ "$output" == *'  init( value: Value )'* ]]
  printf '%s\n' "$output" | grep -Fx '  subscript(index: Int) -> Value { get }'
  [[ "$output" == *'  static func make() -> Self'* ]]
  printf '%s\n' "$output" | grep -Fx '  static var count: Int { get }'
  [[ "$output" == *'  class func classRequirement() -> Self'* ]]
  [[ "$output" == *'  @objc optional func optionalRequirement()'* ]]
  [[ "$output" == *'  @MainActor func attributedRequirement()'* ]]
  [[ "$output" == *'  @MainActor func nextLineAttribute()'* ]]
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

@test "public overrides retain their API signatures regardless of modifier order" {
  export AUTOMOBILE_IOS_API_SOURCES="$FIXTURES/override-order"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -Fx '  public override func startLoading()'
  printf '%s\n' "$output" | grep -Fx '  public override func stopLoading()'
  printf '%s\n' "$output" | grep -Fx '  public override class func canInit( with request: URLRequest ) -> Bool'
  printf '%s\n' "$output" | grep -Fx '  @discardableResult public override func loadCount() -> Int'
  [[ "$output" != *'hidden'* ]]
  [[ "$output" != *'override public'* ]]
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

@test "literal and comment parens do not swallow later declarations" {
  cp "$FIXTURES/findings/Parens.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  case leftParen = "("' "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  case rightParen = ")"' "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  case later' "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  public func afterMultiline()' "$AUTOMOBILE_IOS_API_FILE"
  sed 's/following()/renamedFollowing()/' "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift" > "$BATS_TEST_TMPDIR/changed.swift"
  mv "$BATS_TEST_TMPDIR/changed.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  run bash "$SCRIPT" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'-  public func following()'* ]]
  [[ "$output" == *'+  public func renamedFollowing()'* ]]
}

@test "changing same-line protocol accessors fails the API check" {
  cp "$FIXTURES/findings/Accessors.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  var split: Int' "$AUTOMOBILE_IOS_API_FILE"
  sed 's/{ get set }/{ get }/g' "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift" > "$BATS_TEST_TMPDIR/changed.swift"
  mv "$BATS_TEST_TMPDIR/changed.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  run bash "$SCRIPT" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'-  var value: Int { get set }'* ]]
  [[ "$output" == *'+  var value: Int { get }'* ]]
  [[ "$output" == *'-  subscript(index: Int) -> Int { get set }'* ]]
  [[ "$output" == *'+  subscript(index: Int) -> Int { get }'* ]]
  [[ "$output" == *'-  var commented: Int { get set } // requirement'* ]]
  [[ "$output" == *'+  var commented: Int { get } // requirement'* ]]
}

@test "changing standalone declaration attributes fails the API check" {
  cp "$FIXTURES/findings/Attributes.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  @objc func exposed()' "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  func unannotated()' "$AUTOMOBILE_IOS_API_FILE"
  sed -e 's/@MainActor/@OtherActor/g' -e 's/iOS 17/iOS 18/g' "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift" > "$BATS_TEST_TMPDIR/changed.swift"
  mv "$BATS_TEST_TMPDIR/changed.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  run bash "$SCRIPT" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'-  @MainActor @available(iOS 17, *) public func isolated()'* ]]
  [[ "$output" == *'+  @OtherActor @available(iOS 18, *) public func isolated()'* ]]
  [[ "$output" == *'-  @MainActor @available(iOS 17, *) func isolatedRequirement()'* ]]
  [[ "$output" == *'+  @OtherActor @available(iOS 18, *) func isolatedRequirement()'* ]]
  [[ "$output" == *'-  @MainActor @available(iOS 17, *) case isolatedCase'* ]]
  [[ "$output" == *'+  @OtherActor @available(iOS 18, *) case isolatedCase'* ]]
}

@test "unqualified extensions expose public nested types of earlier public and open types" {
  cp "$FIXTURES/findings/Extensions.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  case openVisible' "$AUTOMOBILE_IOS_API_FILE"
  run cat "$AUTOMOBILE_IOS_API_FILE"
  [[ "$output" != *'hiddenInternal'* ]]
  [[ "$output" != *'hiddenNested'* ]]
  [[ "$output" != *'internalMember'* ]]
  sed 's/case visible/case renamedVisible/' "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift" > "$BATS_TEST_TMPDIR/changed.swift"
  mv "$BATS_TEST_TMPDIR/changed.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  run bash "$SCRIPT" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'-  case visible'* ]]
  [[ "$output" == *'+  case renamedVisible'* ]]
}

@test "changing next-line generic constraints fails the API check and flushes final signatures" {
  cp "$FIXTURES/findings/Where.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  cp "$FIXTURES/legacy/Legacy.swift" "$AUTOMOBILE_IOS_API_SOURCES/ZZZ.swift"
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  public func finalSignature()' "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  public static let notification = Notification.Name( "legacy.notification" )' "$AUTOMOBILE_IOS_API_FILE"
  sed 's/Equatable/Hashable/g' "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift" > "$BATS_TEST_TMPDIR/changed.swift"
  mv "$BATS_TEST_TMPDIR/changed.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  run bash "$SCRIPT" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'-  public func generic<T>(value: T) where T: Equatable'* ]]
  [[ "$output" == *'+  public func generic<T>(value: T) where T: Hashable'* ]]
  [[ "$output" == *'-  func requirement<T>(value: T) where T: Equatable'* ]]
  [[ "$output" == *'+  func requirement<T>(value: T) where T: Hashable'* ]]
  [[ "$output" == *'-  func extended<T>( value: T ) where T: Equatable'* ]]
  [[ "$output" == *'+  func extended<T>( value: T ) where T: Hashable'* ]]
}

@test "changing later lines of comma-separated enum cases fails the API check" {
  cp "$FIXTURES/findings/Cases.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  bash "$SCRIPT" > "$AUTOMOBILE_IOS_API_FILE"
  grep -Fx '  case following' "$AUTOMOBILE_IOS_API_FILE"
  sed -e 's/second/renamedSecond/' -e 's/next(Options)/renamedNext(Options)/' "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift" > "$BATS_TEST_TMPDIR/changed.swift"
  mv "$BATS_TEST_TMPDIR/changed.swift" "$AUTOMOBILE_IOS_API_SOURCES/Surface.swift"
  run bash "$SCRIPT" --check
  [ "$status" -eq 1 ]
  [[ "$output" == *'-  case first, second'* ]]
  [[ "$output" == *'+  case first, renamedSecond'* ]]
  [[ "$output" == *'-  indirect case value( Int ), next(Options), last'* ]]
  [[ "$output" == *'+  indirect case value( Int ), renamedNext(Options), last'* ]]
}
