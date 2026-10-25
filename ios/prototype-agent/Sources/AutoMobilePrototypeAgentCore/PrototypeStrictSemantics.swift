import Foundation

/// Relationships the structural vocabulary cannot express. Runtime evaluators deliberately tolerate
/// missing data; the strict boundary rejects it at the authored path instead.
enum PrototypeStrictSemantics {
    static func layout(_ context: PrototypeContractValidator) throws {
        var parents: [String: [String: JSONValue]] = [:]
        for node in context.locatedNodes {
            if let span = node.value["span"]?.numberValue {
                guard let parent = parents[node.path], parent["type"] == .string("grid"),
                      parent["columns"]?.numberValue.map({ span <= $0 }) != false
                else {
                    throw PrototypeContractValidator.invalid("\(node.path).span", "Invalid grid span")
                }
            }
            for child in PrototypeStrictRepeats
                .children(node.value, path: node.path)
            {
                parents[child.path] = node.value
            }
        }
    }

    /// No child of a staggered container waits longer than this in all (#15247).
    static let maxChoreographyDelayMs = 600.0

    /// How many steps after the first the child at [index] of [count] waits, by stagger [order].
    static func staggerRank(_ index: Int, of count: Int, order: String?) -> Int {
        switch order {
        case "reverse": count - 1 - index
        case "center": abs(2 * index - (count - 1)) / 2
        default: index
        }
    }

    /// The longest wait of a container's `visibleWhen` children: stagger rank times `ms` plus the
    /// child's own `transition.delayMs`. A literal `repeat` multiplies the children; a data-bound
    /// one has no static count, so the device clamps it instead.
    static func longestStaggerDelayMs(_ fields: [String: JSONValue], stagger: [String: JSONValue]) -> Double {
        guard case let .array(all)? = fields["children"] else { return 0 }
        let children = all.filter { $0.objectFields?["visibleWhen"] != nil }
        guard !children.isEmpty else { return 0 }
        let instances: Int
        if case let .array(items)? = fields["repeat"]?.objectFields?["items"] { instances = items.count } else { instances = 1 }
        let count = children.count * instances
        let ms = stagger["ms"]?.numberValue ?? 0
        let order = stagger["order"]?.stringValue
        return (0 ..< count).map { index -> Double in
            let own = children[index % children.count].objectFields?["transition"]?.objectFields?["delayMs"]?
                .numberValue ?? 0
            return Double(staggerRank(index, of: count, order: order)) * ms + own
        }.max() ?? 0
    }

    static func storage(_ fields: [String: JSONValue]) throws {
        guard let storage = fields["storage"]?.objectFields else { return }
        var pointers: [String] = []
        var bytes = 0
        for (index, key) in PrototypeContractValidator.strings(storage["keys"]).enumerated() {
            let path = "storage.keys[\(index)]"
            guard let parsed = PrototypeStorageKey.parse(key) else { throw PrototypeContractValidator.invalid(
                path,
                "Invalid storage key"
            ) }
            let value: JSONValue?
            switch parsed {
            case let .state(name):
                guard let stored = fields["state"]?.objectFields?[name]
                else { throw PrototypeContractValidator.invalid(path, "Undeclared storage state") }
                value = stored
            case let .data(pointer):
                if pointers
                    .contains(where: { $0 == pointer || $0.hasPrefix(pointer + "/") || pointer.hasPrefix($0 + "/") })
                {
                    throw PrototypeContractValidator.invalid(path, "Overlapping storage pointers")
                }
                pointers.append(pointer)
                value = PrototypeDataPointer.resolve(fields["data"]?.objectFields, pointer: pointer)
            }
            if let value { bytes += PrototypeStorageBytes.entry(key, value) }
        }
        if bytes > PrototypeLimits.maxStorageBytes { throw PrototypeContractValidator.invalid(
            "storage.keys",
            "Storage byte limit exceeded"
        ) }
    }

    static func vocabulary(_ context: PrototypeContractValidator, data: [String: JSONValue]?) throws {
        for node in context.locatedNodes {
            let fields = node.value, path = node.path, type = fields["type"]?.stringValue
            if !["box", "row", "column", "card"].contains(type ?? "") {
                if fields["style"]?
                    .objectFields?["shimmer"] !=
                    nil { throw PrototypeContractValidator.invalid("\(path).style.shimmer", "Invalid shimmer node") }
                for (index, style) in PrototypeStrictBindings.array(fields["styleWhen"]).enumerated()
                    where style.objectFields?["style"]?.objectFields?["shimmer"] != nil
                {
                    throw PrototypeContractValidator.invalid(
                        "\(path).styleWhen[\(index)].style.shimmer",
                        "Invalid shimmer node"
                    )
                }
            }
            if type == "image", fields["zoomable"] != nil,
               fields["onDoubleTap"] !=
               nil { throw PrototypeContractValidator.invalid("\(path).zoomable", "Zoomable claims double tap") }
            if let stagger = fields["stagger"]?.objectFields,
               longestStaggerDelayMs(fields, stagger: stagger) > maxChoreographyDelayMs
            {
                throw PrototypeContractValidator.invalid(
                    "\(path).stagger",
                    "Stagger and transition delays add up to more than \(Int(maxChoreographyDelayMs)) ms"
                )
            }
            if type == "chart" { try chart(fields, path: path, data: data) }
            if type == "scroll", fields["axis"] == .string("horizontal"),
               let key = ["reverse", "stickToEnd", "atEndKey", "onStartReached"].first(where: { fields[$0] != nil })
            {
                throw PrototypeContractValidator.invalid("\(path).\(key)", "Chat needs vertical scroll")
            }
        }
        for action in context.actions where action.value["type"] == .string("scrollTo") {
            let matches = context.locatedNodes
                .filter { $0.value["type"] == .string("scroll") && $0.value["id"] == action.value["scroll"] }
            if matches.count != 1 { throw PrototypeContractValidator.invalid(
                "\(action.path).scroll",
                "Unknown or duplicate scroll"
            ) }
        }
    }

    private static func chart(_ fields: [String: JSONValue], path: String, data: [String: JSONValue]?) throws {
        let series = PrototypeStrictBindings.array(fields["series"])
        if fields["variant"] == .string("ring") {
            if series.count != 1 { throw PrototypeContractValidator.invalid("\(path).series", "Ring needs one series") }
            if (fields["goal"]?.numberValue ?? 0) <=
                0 { throw PrototypeContractValidator.invalid("\(path).goal", "Ring needs positive goal") }
        }
        if let range = fields["yRange"]?.objectFields, let min = range["min"]?.numberValue,
           let max = range["max"]?.numberValue, max <= min
        {
            throw PrototypeContractValidator.invalid("\(path).yRange.max", "Inverted range")
        }
        for (index, entry) in series.enumerated() {
            guard let item = entry.objectFields, let pointer = item["path"]?.stringValue,
                  !pointer.contains("{") else { continue }
            let at = "\(path).series[\(index)]"
            guard case let .array(points)? = PrototypeDataPointer.resolve(data, pointer: pointer),
                  points.allSatisfy({ $0.objectFields != nil })
            else { throw PrototypeContractValidator.invalid(
                "\(at).path",
                "Invalid chart source"
            ) }
            if points
                .contains(where: { $0.objectFields?[item["y"]?.stringValue ?? ""]?.numberValue == nil })
            {
                throw PrototypeContractValidator.invalid("\(at).y", "Invalid chart ordinate")
            }
        }
    }

    static func targets(_ context: PrototypeContractValidator) throws {
        var pagers = Set<String>(), stacks: [String: [String: JSONValue]] = [:]
        for node in context.locatedNodes {
            let fields = node.value, path = node.path, type = fields["type"]?.stringValue
            if type == "pager", let id = fields["id"]?.stringValue,
               !pagers.insert(id).inserted { throw PrototypeContractValidator.invalid("\(path).id", "Duplicate pager") }
            if type == "stack", let id = fields["id"]?.stringValue {
                if stacks[id] != nil { throw PrototypeContractValidator.invalid("\(path).id", "Duplicate stack") }
                let screens = fields["screens"]?.objectFields ?? [:]
                if screens[fields["start"]?.stringValue ?? ""] ==
                    nil { throw PrototypeContractValidator.invalid("\(path).start", "Unknown start") }
                stacks[id] = screens
            }
        }
        for entry in context.locatedNodes + context.actions {
            if let pager = entry.value["pager"]?.stringValue,
               !pagers
               .contains(pager) { throw PrototypeContractValidator.invalid("\(entry.path).pager", "Unknown pager") }
        }
        for action in context.actions {
            if let context = action.value["context"]?.objectFields {
                for (key, value) in context {
                    if let pager = value.objectFields?["page"]?.stringValue,
                       !pagers
                       .contains(pager)
                    {
                        throw PrototypeContractValidator
                            .invalid(PrototypeContractValidator.keyPath("\(action.path).context", key), "Unknown pager")
                    }
                }
            }
            if let stack = action.value["stack"]?.stringValue {
                guard let screens = stacks[stack] else { throw PrototypeContractValidator.invalid(
                    "\(action.path).stack",
                    "Unknown stack"
                ) }
                if let screen = action.value["screen"]?.stringValue,
                   screens[screen] ==
                   nil { throw PrototypeContractValidator.invalid("\(action.path).screen", "Unknown screen") }
            }
        }
    }
}
