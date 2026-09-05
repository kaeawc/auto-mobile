/// Front-truncating max-size helpers for a bounded ring buffer.
///
/// Carried forward from Paul's incremental-fixup experiment on the reference target
/// (preserved as a clean utility). Semantically identical to the reference's inline
/// `while buffer.count > max { buffer.removeFirst() }`: append, then drop from the
/// front until the count is within `maximumSize`, keeping the most-recent elements.
extension RangeReplaceableCollection {
    /// Removes elements from the front until we're under our maximum size; returns
    /// the number removed, if any.
    @discardableResult
    mutating func removePrefix(enforcingMaximumSize maximumSize: Int) -> Int {
        assert(maximumSize >= 0)
        defer { assert(count <= maximumSize) }
        let count = self.count
        let overage = count - maximumSize
        guard overage > 0 else { return 0 }
        removeFirst(overage)
        return overage
    }

    /// Shorthand for "append element, then truncate from the front".
    mutating func append(_ element: Element, enforcingMaximumSize maximumSize: Int) {
        assert(maximumSize >= 0)
        append(element)
        removePrefix(enforcingMaximumSize: maximumSize)
    }

    /// Shorthand for "append elements, then truncate from the front".
    mutating func append(
        contentsOf elements: some Sequence<Element>,
        enforcingMaximumSize maximumSize: Int
    ) {
        append(contentsOf: elements)
        removePrefix(enforcingMaximumSize: maximumSize)
    }
}
