import Foundation
import os

private let lazyListLog = Logger(subsystem: "dev.jasonpearson.automobile.prototype-agent", category: "prototype")

struct PrototypeListRepeat: Decodable {
    struct Items: Decodable { let path: String }
    let items: Items
    let `as`: String
    let key: String
}

/// Resolved independently so a renderer can compose rows without expanding the authored tree.
enum PrototypeLazyList {
    static let capability = "prototype_lazy_list_v1"

    struct Row {
        let key: String
        let index: Int
        let node: PrototypeNode
    }

    /// Identity only: no template binding, data resolution or JSON coding.
    static func keys(node: PrototypeNode, data: [String: JSONValue]?) -> [String] {
        guard let spec = node.listRepeat,
              case let .array(items)? = PrototypeDataPointer.resolve(data, pointer: spec.items.path)
        else { return [] }
        return items.map { value in
            guard PrototypeRepeat.isFieldName(spec.key), let key = value.objectFields?[spec.key],
                  PrototypeDataValues.isScalar(key) else { return "" }
            return key.displayString
        }
    }

    static func row(node: PrototypeNode, data: [String: JSONValue]?, index: Int) throws -> Row? {
        guard let spec = node.listRepeat, let raw = node.listRowTemplate,
              case let .array(items)? = PrototypeDataPointer.resolve(data, pointer: spec.items.path),
              items.indices.contains(index) else { return nil }
        let fields = PrototypeDataValues.project(items[index].objectFields ?? [:]).objectFields ?? [:]
        let bound = PrototypeRepeatInstance(alias: spec.as, item: fields, index: index).bind(raw)
        let resolved = PrototypeDataResolver.resolveRoot(bound, data: data)
        let row = try JSONDecoder().decode(PrototypeNode.self, from: JSONEncoder().encode(resolved))
        return Row(key: fields[spec.key]?.displayString ?? "", index: index, node: row)
    }

    static func rows(node: PrototypeNode, data: [String: JSONValue]?) throws -> [Row] {
        try keys(node: node, data: data).indices.compactMap { try row(node: node, data: data, index: $0) }
    }

    /// Owned by a single lazy cell, so a malformed row is absent and warns once per cell lifetime.
    final class RowDecoder {
        private var reportedFailure = false
        private let warning: (String) -> Void
        private let load: (PrototypeNode, [String: JSONValue]?, Int) throws -> Row?

        init(
            warning: @escaping (String) -> Void = { lazyListLog.warning("\($0, privacy: .private)") },
            load: @escaping (PrototypeNode, [String: JSONValue]?, Int) throws -> Row? = {
                try row(node: $0, data: $1, index: $2)
            }
        ) {
            self.warning = warning
            self.load = load
        }

        func decode(node: PrototypeNode, data: [String: JSONValue]?, index: Int) -> Row? {
            do { return try load(node, data, index) }
            catch {
                if !reportedFailure {
                    reportedFailure = true
                    warning("Could not decode lazy list row at \(node.nodePath)[\(index)]: \(error)")
                }
                return nil
            }
        }
    }

    static func listMaxItems(spec: PrototypeSpec, dataPath: String) -> Int? {
        listMaxItems(root: spec.authoredRoot, dataPath: dataPath)
    }

    static func listMaxItems(root: JSONValue, dataPath: String) -> Int? {
        var maximum: Int?
        walk(root) { node, _ in
            if node["type"] == .string("list"),
               let path = node["repeat"]?.objectFields?["items"]?.objectFields?["path"]?.stringValue,
               "/data\(path)".utf16.elementsEqual(dataPath.utf16), let limit = node["maxItems"]?.intValue
            { maximum = min(maximum ?? limit, limit) }
        }
        return maximum
    }

    static func walk(_ root: JSONValue, path: String = "root", visit: ([String: JSONValue], String) -> Void) {
        guard let node = root.objectFields else { return }
        visit(node, path)
        for child in PrototypeStrictRepeats.children(node, path: path) {
            walk(.object(child.value), path: child.path, visit: visit)
        }
    }

    static func validateLimits(root: JSONValue, data: [String: JSONValue]?) throws {
        var failure: PrototypeLoadError?
        walk(root) { node, path in
            guard failure == nil, node["type"] == .string("list"),
                  let pointer = node["repeat"]?.objectFields?["items"]?.objectFields?["path"]?.stringValue,
                  case let .array(items)? = PrototypeDataPointer.resolve(data, pointer: pointer)
            else { return }
            if items.count > PrototypeLimits.maxListItems {
                failure = PrototypeContractValidator.invalid(
                    "\(path).repeat.items.path",
                    "Repeat path resolves to more than \(PrototypeLimits.maxListItems) items"
                )
            }
        }
        if let failure { throw failure }
    }

    static func validate(root: JSONValue, data: [String: JSONValue]?, state: [String: JSONValue]) throws {
        var nodes: [PrototypeLocatedValue] = []
        walk(root) { node, path in nodes.append(.init(value: node, path: path)) }
        for entry in nodes {
            let node = entry.value, path = entry.path
            let type = node["type"]?.stringValue ?? ""
            let ancestors = nodes.filter { path.hasPrefix("\($0.path).") }
            let axis = node["axis"]?.stringValue ?? "vertical"
            func reject(_ message: String, field: String = "") throws {
                throw PrototypeContractValidator.invalid(path + field, message)
            }
            if type == "list" {
                if ancestors.contains(where: { $0.value["type"] == .string("list") }) {
                    try reject("A list cannot sit inside another list")
                }
                if ancestors.contains(where: { $0.value["repeat"] != nil && path.hasPrefix("\($0.path).children[") }) {
                    try reject("A list cannot sit inside a repeat template")
                }
                if ancestors.contains(where: {
                    $0.value["type"] == .string("scroll") && ($0.value["axis"]?.stringValue ?? "vertical") == axis
                }) { try reject("A list cannot sit inside a scroll on the same axis") }
                if node["endThreshold"] != nil, node["onEndReached"] == nil {
                    try reject("endThreshold needs onEndReached", field: ".endThreshold")
                }
                if node["onEndReached"] != nil, let maxItems = node["maxItems"]?.intValue,
                   maxItems <= (node["endThreshold"]?.intValue ?? 3)
                {
                    try reject("maxItems must be greater than endThreshold", field: ".maxItems")
                }
                if let refresh = node["refresh"]?.objectFields {
                    if axis == "horizontal" { try reject("Pull-to-refresh needs a vertical list", field: ".refresh") }
                    let key = refresh["stateKey"]?.stringValue ?? ""
                    if PrototypeRoutes.fields(key).isEmpty, state[key]?.boolValue == nil {
                        try reject("Refresh requires a boolean state key", field: ".refresh.stateKey")
                    }
                }
                if let pointer = node["repeat"]?.objectFields?["items"]?.objectFields?["path"]?.stringValue {
                    guard case let .array(items)? = PrototypeDataPointer.resolve(data, pointer: pointer) else {
                        try reject("Repeat path does not resolve to an array", field: ".repeat.items.path")
                        continue
                    }
                    if items.count > PrototypeLimits.maxListItems {
                        try reject(
                            "Repeat path resolves to more than \(PrototypeLimits.maxListItems) items",
                            field: ".repeat.items.path"
                        )
                    }
                    if let maxItems = node["maxItems"]?.intValue, items.count > maxItems {
                        try reject("List data has more items than maxItems", field: ".repeat.items.path")
                    }
                    if let index = items.firstIndex(where: { $0.objectFields == nil }) {
                        try reject("Repeat path item \(index) is not an object", field: ".repeat.items.path")
                    }
                }
            }
            if type == "scroll", ancestors.contains(where: {
                $0.value["type"] == .string("list") && ($0.value["axis"]?.stringValue ?? "vertical") == axis
            }) { try reject("A scroll cannot sit inside a list on the same axis") }
        }
        if nodes.contains(where: { $0.value["type"] == .string("list") }) {
            var repeats = PrototypeStrictRepeats(data: data)
            try repeats.templates(root.objectFields ?? [:], path: "root")
        }
        // Request checks here also cover direct PrototypeSpec decoding.
        var actions: [PrototypeLocatedValue] = []
        func scan(_ value: JSONValue, path: String) {
            if case let .array(items) = value {
                for (index, item) in items.enumerated() {
                    scan(item, path: "\(path)[\(index)]")
                }
            }
            guard let fields = value.objectFields else { return }
            if fields["type"] == .string("request") { actions.append(.init(value: fields, path: path)) }
            for (key, child) in fields where !["payload", "value", "repeat", "body"].contains(key) {
                scan(child, path: PrototypeContractValidator.keyPath(path, key))
            }
        }
        scan(root, path: "root")
        try validateAppend(actions: actions, data: data)
    }

    static func validateAppend(actions: [PrototypeLocatedValue], data: [String: JSONValue]?) throws {
        for action in actions {
            guard let append = action.value["append"]?.objectFields,
                  let to = append["to"]?.stringValue else { continue }
            let path = "\(action.path).append.to"
            try PrototypeRequestValidator.into(.string(to), path: path)
            if let into = action.value["into"]?.stringValue,
               to == into || to.hasPrefix("\(into)/") || into.hasPrefix("\(to)/")
            { throw PrototypeContractValidator.invalid(path, "append.to must not overlap into") }
            if !to.split(separator: "/").contains("{index}"),
               let target = PrototypeDataPointer.resolve(data, pointer: String(to.dropFirst(5)))
            {
                guard case .array = target else { throw PrototypeContractValidator.invalid(
                    path,
                    "append.to must name an array"
                ) }
            }
        }
    }
}

/// Per-list state retained by the renderer until the next show. No time or scheduling dependency.
struct PrototypeListEndTrigger {
    let endThreshold: Int
    private var fired: (count: Int, key: [UInt16]?)?

    init(endThreshold: Int = 3) { self.endThreshold = endThreshold }

    mutating func onVisibleRange(lastVisibleIndex: Int, rowCount: Int, lastRowKey: String?) -> Bool {
        guard rowCount > 0, lastVisibleIndex >= rowCount - endThreshold else { return false }
        let key = lastRowKey.map { Array($0.utf16) }
        guard fired?.count != rowCount || fired?.key != key else { return false }
        fired = (rowCount, key)
        return true
    }
}
