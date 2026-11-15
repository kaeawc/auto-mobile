import Foundation

/// R1: a library spec reaches no `sensitive` platform call or event handler (#15636). The twin of
/// TypeScript's `sensitiveModuleLibraryError` and Kotlin's `PrototypeLibraryModuleRule`: handlers in
/// sorted order (each refused before its body is scanned), then channel handlers, then `root`.
enum PrototypeLibraryModuleRule {
    /// A sensitive call or handler at the host validator's path, with the module that owns it.
    struct Use: Equatable {
        let path: String
        let message: String
        let module: String
    }

    /// Throws at the first sensitive call or handler, with the host validator's path and message.
    static func validate(_ spec: [String: JSONValue]) throws {
        if let use = uses(spec).first { throw PrototypeContractValidator.invalid(use.path, use.message) }
    }

    /// Every sensitive call and handler, in the order the host validator reports them.
    static func uses(_ spec: [String: JSONValue]) -> [Use] {
        var found: [Use] = []
        let handlers = spec["platform"]?.objectFields?["on"]?.objectFields ?? [:]
        for event in sorted(handlers.keys) {
            let path = "platform.on[\(quoted(event))]"
            if let module = sensitiveModule(event, kind: "events") {
                found.append(Use(
                    path: path, message: "Sensitive platform event \(event) is unavailable in a library", module: module
                ))
            }
            if let handler = handlers[event] { scan(handler, path: path, into: &found) }
        }
        for (handler, path) in PrototypeChannels.handlers(spec["channels"]?.objectFields ?? [:]) {
            scan(handler, path: path, into: &found)
        }
        if let root = spec["root"] { scan(root, path: "root", into: &found) }
        return found
    }

    /// Emit payloads and literal repeat items are data; a `{value}` binding's literal is opaque.
    private static let opaqueKeys: Set<String> = ["payload", "repeat"]

    private static func scan(_ value: JSONValue, path: String, into found: inout [Use]) {
        switch value {
        case let .array(items):
            for (index, item) in items.enumerated() {
                scan(item, path: "\(path)[\(index)]", into: &found)
            }
        case let .object(fields):
            if fields.count == 1, fields["value"] != nil { return }
            // A `pasteButton` node runs `clipboard.paste` into its `into` path.
            let call = fields["type"] == .string("pasteButton") ? "clipboard.paste" :
                (fields["type"] == .string("platform") ? fields["call"]?.stringValue : nil)
            if let call, let module = sensitiveModule(call, kind: "calls") {
                found.append(Use(
                    path: path, message: "Sensitive platform call \(call) is unavailable in a library", module: module
                ))
            }
            for key in sorted(fields.keys) {
                guard let member = fields[key], !opaqueKeys.contains(key) else { continue }
                if key == "screens", let screens = member.objectFields {
                    // Stack screens are named in brackets, as the host's screen-map walk reports them.
                    for name in sorted(screens.keys) {
                        if let screen = screens[name] {
                            scan(screen, path: "\(path).screens[\(quoted(name))]", into: &found)
                        }
                    }
                    continue
                }
                scan(member, path: PrototypeLimits.dataMemberPath(path, key: key), into: &found)
            }
        default:
            break
        }
    }

    /// The module owning `module.member` when the contract marks it `sensitive` under `kind`.
    private static func sensitiveModule(_ name: String, kind: String) -> String? {
        guard let dot = name.firstIndex(of: ".") else { return nil }
        let module = String(name[..<dot])
        let definition = PrototypeContractValidator.platformModules[module]?.objectFields?[kind]?
            .objectFields?[String(name[name.index(after: dot)...])]?.objectFields
        return definition?["sensitive"] == .bool(true) ? module : nil
    }

    private static func sorted(_ keys: [String: JSONValue].Keys) -> [String] {
        keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    }

    private static func quoted(_ name: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        return (try? encoder.encode(name)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }
}

/// R6: the `sensitive` platform modules an imported prototype uses, for ProtoViewer's app-reserved
/// provenance region (#15636). R1 refuses these in a library today, so a validated import yields
/// none; the region is the backstop if R1 is relaxed.
enum PrototypeLibraryProvenance {
    /// Module names in UTF-16 order; malformed data yields none, since the loader reports it.
    static func sensitiveModules(_ spec: Data) -> [String] {
        guard let fields = (try? JSONDecoder().decode(JSONValue.self, from: spec))?.objectFields else { return [] }
        return sensitiveModules(fields)
    }

    static func sensitiveModules(_ spec: [String: JSONValue]) -> [String] {
        Set(PrototypeLibraryModuleRule.uses(spec).map(\.module))
            .sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    }
}
