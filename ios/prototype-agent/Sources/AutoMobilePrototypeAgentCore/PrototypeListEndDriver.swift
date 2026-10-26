/// Session-owned visibility high-water mark plus the shared signature edge trigger.
struct PrototypeListEndDriver {
    private var trigger: PrototypeListEndTrigger
    private var lastVisibleIndex = -1

    init(endThreshold: Int = 3) { trigger = PrototypeListEndTrigger(endThreshold: endThreshold) }

    mutating func update(appearedIndex: Int?, rowKeys: [String]) -> Bool {
        if let appearedIndex { lastVisibleIndex = max(lastVisibleIndex, appearedIndex) }
        guard lastVisibleIndex >= 0 else { return false }
        return trigger.onVisibleRange(
            lastVisibleIndex: lastVisibleIndex,
            rowCount: rowKeys.count,
            lastRowKey: rowKeys.last
        )
    }
}
