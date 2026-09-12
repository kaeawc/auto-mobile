import Foundation

/// Narrow seam the `HierarchyDebouncer` uses to pull the current view hierarchy.
///
/// The reference debouncer depended on the whole `ElementLocating` protocol but called
/// exactly one of its ~20 methods. This narrows the dependency to that one method
/// (YAGNI — grow the interface when a second consumer needs more) and insulates the
/// debouncer from whatever async surface `ElementLocating` grows in Phase 4F.
///
/// `@MainActor` because view-hierarchy extraction touches UIKit and must run on the
/// main thread; the eventual `ElementLocator` is itself `@MainActor` and satisfies this
/// synchronously by conformance. Keeping the method synchronous (not `async`) is what
/// lets the `@MainActor` debouncer poll and hash inside a single main-actor turn,
/// preserving the reference's synchronous extract-compare-broadcast ordering.
@MainActor
protocol HierarchyExtracting {
    func getViewHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy
}
