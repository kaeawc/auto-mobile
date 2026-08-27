@testable import CtrlProxyRewrite
import Foundation

/// `@MainActor` test double for the rewrite `HierarchyExtracting` seam. Mirrors the
/// reference `FakeElementLocator`'s hierarchy-read surface: returns the currently
/// configured hierarchy on every read, can be told to throw, counts reads (incremented
/// even on a throw, matching the reference) and fires `onRead` only on the success path
/// (also matching the reference, whose `onHierarchyRead` runs after the throw check).
/// `@MainActor`-isolated, so its plain mutable state needs no lock.
@MainActor
final class FakeHierarchyExtractor: HierarchyExtracting {
    private var hierarchy: ViewHierarchy?
    private var shouldThrow = false
    private(set) var requestCount = 0
    var onRead: (() -> Void)?

    func setHierarchy(_ hierarchy: ViewHierarchy?) {
        self.hierarchy = hierarchy
    }

    func setShouldThrow(_ shouldThrow: Bool) {
        self.shouldThrow = shouldThrow
    }

    func getViewHierarchy(disableAllFiltering _: Bool) throws -> ViewHierarchy {
        requestCount += 1
        if shouldThrow {
            throw DebouncerFakeError()
        }
        guard let hierarchy else {
            // Scenarios always configure a hierarchy before the first read; this guard
            // just makes a misuse loud instead of silently returning a default.
            throw DebouncerFakeError()
        }
        onRead?()
        return hierarchy
    }
}
