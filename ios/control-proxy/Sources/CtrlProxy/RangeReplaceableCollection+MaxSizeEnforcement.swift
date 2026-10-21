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
