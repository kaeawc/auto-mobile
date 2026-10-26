/// Session-owned visible identities plus the shared signature edge trigger.
struct PrototypeListEndDriver {
    private var trigger: PrototypeListEndTrigger
    private var visibleKeys: Set<String> = []

    init(endThreshold: Int = 3) { trigger = PrototypeListEndTrigger(endThreshold: endThreshold) }

    mutating func update(appearedKey: String? = nil, disappearedKey: String? = nil, rowKeys: [String]) -> Bool {
        if let appearedKey { visibleKeys.insert(appearedKey) }
        if let disappearedKey { visibleKeys.remove(disappearedKey) }
        guard let lastVisibleIndex = rowKeys.lastIndex(where: { visibleKeys.contains($0) }) else { return false }
        return trigger.onVisibleRange(
            lastVisibleIndex: lastVisibleIndex,
            rowCount: rowKeys.count,
            lastRowKey: rowKeys.last
        )
    }
}
