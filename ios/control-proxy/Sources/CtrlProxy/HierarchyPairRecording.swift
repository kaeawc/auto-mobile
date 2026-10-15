import Foundation

/// Records each `(xcuitest, sdk)` input pair the runner hands to `HierarchyMerger` on
/// the `request_hierarchy` refresh path, so real pairs can be replayed through the
/// merger in unit tests (#5837). Opt-in; production wiring passes `nil` unless the
/// capture environment variable is set.
public protocol HierarchyPairRecording: Sendable {
    func record(xcuitest: ViewHierarchy, sdk: SdkViewHierarchy)
}
