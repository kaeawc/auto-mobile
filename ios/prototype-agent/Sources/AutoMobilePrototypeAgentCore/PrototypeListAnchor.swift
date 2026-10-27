/// Row identities alone participate in anchoring; headers and footers never enter this set.
enum PrototypeListAnchor {
    static func resolve(anchorKey: String?, newKeys: [String]) -> String? {
        anchorKey.flatMap { newKeys.contains($0) ? $0 : nil }
    }
}

/// Session entry IDs distinguish repeated pushes of the same screen. Covered entries survive;
/// popped/replaced entries are removed immediately, including writes from an exiting view.
struct PrototypeStackListAnchorStore {
    private var entries: Set<Int> = []
    private var anchors: [Int: [String: String]] = [:]

    mutating func retain(entryIDs: Set<Int>) {
        entries = entryIDs
        anchors = anchors.filter { entries.contains($0.key) }
    }

    mutating func save(entryID: Int, listPath: String, key: String?) {
        guard entries.contains(entryID) else { return }
        anchors[entryID, default: [:]][listPath] = key
    }

    mutating func read(entryID: Int, listPath: String, newKeys: [String]) -> String? {
        let key = PrototypeListAnchor.resolve(anchorKey: anchors[entryID]?[listPath], newKeys: newKeys)
        save(entryID: entryID, listPath: listPath, key: key)
        return key
    }
}
