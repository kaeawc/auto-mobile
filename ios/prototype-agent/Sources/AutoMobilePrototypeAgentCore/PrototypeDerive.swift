import Foundation

struct PrototypeDeriveChanges {
    var dataPointers: Set<String> = []
    var stateKeys: Set<String> = []
}

protocol PrototypeDeriveObserver {
    func recomputed(name: String)
}

/// Raw values only; formatting belongs to the existing placeholder resolver.
enum PrototypeDerive {
    static func evaluate(
        _ derive: [String: PrototypeDerivedEntry]?, data: [String: JSONValue]?, state: [String: JSONValue],
        previous: [String: JSONValue]? = nil, changed: PrototypeDeriveChanges? = nil,
        observer: PrototypeDeriveObserver? = nil
    )
        -> [String: JSONValue]
    {
        var result: [String: JSONValue] = [:]
        for (name, entry) in derive ?? [:] {
            if let previous, let cached = previous[name], let changed, !affected(entry, changed: changed) {
                result[name] = cached
            } else {
                observer?.recomputed(name: name)
                // A null sentinel keeps missing inputs cached, including removed state keys.
                result[name] = value(entry, data: data, state: state) ?? .null
            }
        }
        return result
    }

    static func affected(_ entry: PrototypeDerivedEntry, changed: PrototypeDeriveChanges) -> Bool {
        let source = entry.collection?["of"]?.objectFields ?? entry.of
        let keys = entry.collection.map { collection in
            PrototypeCollection.clauses(collection).compactMap { $0["value"]?.objectFields?["state"]?.stringValue }
        } ?? [source["state"]?.stringValue].compactMap { $0 }
        if keys.contains(where: changed.stateKeys.contains) { return true }
        guard let pointer = source["data"]?.stringValue else { return false }
        return changed.dataPointers.contains { path in
            path == pointer || path.hasPrefix(pointer + "/") || pointer.hasPrefix(path + "/")
        }
    }

    static func value(
        _ entry: PrototypeDerivedEntry, data: [String: JSONValue]?, state: [String: JSONValue]
    )
        -> JSONValue?
    {
        if let collection = entry.collection {
            return PrototypeCollection.collect(collection, reduce: entry.reduce, data: data, state: state)
        }
        if let pointer = entry.of["data"]?.stringValue { return PrototypeDataPointer.resolve(data, pointer: pointer) }
        if let key = entry.of["state"]?.stringValue { return state[key] }
        return entry.of["value"]
    }

    static func text(_ value: JSONValue?) -> String {
        guard let value, PrototypeDataValues.isScalar(value) else { return "" }
        return value.displayString
    }
}
