/// Pure frame coalescing, pinned by the shared `realtime/coalesce.json` vectors.
enum PrototypeChannelCoalescer {
    private static func target(_ action: JSONValue) -> [UInt8]? {
        guard let fields = action.objectFields else { return nil }
        switch fields["type"]?.stringValue {
        case "setData":
            return fields["path"]?.stringValue.map { Array("data:\($0)".utf8) }
        case "setState":
            return fields["key"]?.stringValue.map { Array("state:\($0)".utf8) }
        default:
            return nil
        }
    }

    /// UTF-8 targets preserve exact string identity, without Swift's Unicode normalization equality.
    private static func signature(_ frame: [JSONValue]) -> Set<[UInt8]>? {
        guard !frame.isEmpty else { return nil }
        var targets = Set<[UInt8]>()
        for action in frame {
            guard let target = target(action) else { return nil }
            targets.insert(target)
        }
        return targets
    }

    /// Reduce each consecutive run of same-target writes to its last frame within one flush window.
    static func coalesce(_ frames: [[JSONValue]]) -> [[JSONValue]] {
        var kept: [[JSONValue]] = []
        var previous: Set<[UInt8]>?
        for frame in frames {
            let signature = signature(frame)
            if let signature, signature == previous {
                kept[kept.count - 1] = frame
            } else {
                kept.append(frame)
            }
            previous = signature
        }
        return kept
    }
}
