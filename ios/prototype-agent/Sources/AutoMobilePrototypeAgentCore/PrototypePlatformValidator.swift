import Foundation

/// The agent-side backstop for the platform vocabulary (#14294): root `requires`, `platform.on`
/// handlers, the `platform` action and `{platform}` / `{event}` reads. The host validator
/// (`prototypePlatform.ts` and the contract walk) is authoritative; this repeats its rules so a
/// spec that skipped it still fails the show at the host's path. Running the calls is the module
/// registry's job; the device module supplies read-only state.
enum PrototypePlatformValidator {
    /// A literal `{value}` argument's rule, from the contract's `platformModules` table.
    enum Rule: Equatable {
        case json(maxBytes: Int)
        case string([String: JSONValue])
        case boolean
        case integer(min: Double, max: Double)
        case enumeration(Set<String>)
        /// Any other contract rule (arrays, objects), checked by the shared contract walk.
        case contract(JSONValue)
    }

    struct Argument: Equatable {
        let optional: Bool
        let rule: Rule
    }

    struct Call: Equatable {
        let args: [String: Argument]
        let permissions: [String]
        let background: [String]
    }

    struct Module: Equatable {
        let capability: String
        let calls: [String: Call]
        let events: Set<String>
        var state: Set<String>?
    }

    /// The contract's `platformModules`; `PrototypePlatformTests` keeps the two equal. `test` is a
    /// placeholder module no production runtime advertises.
    static let modules: [String: Module] = PrototypeContractValidator.platformModules
        .mapValues { raw in
            let fields = raw.objectFields ?? [:]
            let calls = (fields["calls"]?.objectFields ?? [:]).mapValues { raw in
                let call = raw.objectFields ?? [:]
                let args = (call["args"]?.objectFields ?? [:]).mapValues { raw in
                    let arg = raw.objectFields ?? [:]
                    let rule = arg["value"]?.objectFields ?? [:]
                    return Argument(
                        optional: arg["optional"] == .bool(true),
                        rule: argumentRule(rule)
                    )
                }
                func strings(_ key: String) -> [String] {
                    guard case let .array(values)? = call[key] else { return [] }
                    return values.compactMap(\.stringValue)
                }
                return Call(args: args, permissions: strings("permissions"), background: strings("background"))
            }
            return Module(
                capability: fields["capability"]?.stringValue ?? "",
                calls: calls,
                events: Set((fields["events"]?.objectFields ?? [:]).keys),
                state: fields["state"]?.objectFields.map { Set($0.keys) }
            )
        }

    private static func argumentRule(_ rule: [String: JSONValue]) -> Rule {
        switch rule["kind"]?.stringValue {
        case "json": .json(maxBytes: Int(rule["maxBytes"]?.numberValue ?? 0))
        case "string": .string(rule)
        case "boolean": .boolean
        case "enum":
            if case let .array(values)? = rule["values"] {
                .enumeration(Set(values.compactMap(\.stringValue)))
            } else {
                preconditionFailure("platform enum argument without values")
            }
        case "number": .integer(min: rule["min"]?.numberValue ?? 0, max: rule["max"]?.numberValue ?? 0)
        default: .contract(.object(rule))
        }
    }

    static let permissionNames: Set<String> = [
        "camera", "microphone", "location", "locationBackground", "notifications", "photos",
        "photosAdd", "contacts", "calendar", "bluetooth", "nearbyWifi", "motion", "speech",
    ]
    static let backgroundNames: Set<String> = [
        "audio", "location", "call", "connectedDevice", "transfer", "camera", "microphone",
        "remoteNotification",
    ]
    static let reservedEmitPrefix = "prototype_"
    /// Authored `testTag`s cannot start with this; host controls own the namespace (#15120).
    static let reservedTestTagPrefix = "automobile-"
    static let maxArgs = 16
    static let maxHandlers = 32
    static let maxTimeoutMs = 300_000
    private static let maxActionList = 32
    private static let bindingKeys: Set<String> = ["state", "data", "value", "item", "index", "platform", "event"]
    private static let actionFields: Set<String> = [
        "type", "call", "args", "into", "statusKey", "timeoutMs", "onSuccess", "onError",
    ]
    /// Fields whose strings take text placeholders; the host binds exactly the text fields.
    private static let textKeys: Set<String> = [
        "text", "label", "title", "placeholder", "headline", "supporting", "supportingText", "trailingText",
    ]
    /// Emit payloads and literal repeat items are data, never vocabulary.
    private static let opaqueKeys: Set<String> = ["payload", "repeat"]

    private struct Declared {
        var modules: Set<String> = []
        var permissions: Set<String> = []
        var background: Set<String> = []
        var channels: [String: JSONValue] = [:]
        /// Whether the spec has a root `auth` block for `auth.*` calls (#14303).
        var hasAuth = false
        /// `state:` keys kept in secure storage, which an emit context may not carry (#14321).
        var secureKeys: [String] = []
        var players: Set<String> = []
    }

    /// Throws the first platform rule the spec breaks, at the host validator's path.
    static func validate(
        requires: JSONValue?, handlers: JSONValue?, channels: JSONValue? = nil, auth: JSONValue? = nil,
        storage: JSONValue? = nil, location: JSONValue? = nil, media: JSONValue? = nil, root: JSONValue,
        state: [String: JSONValue]
    )
        throws
    {
        try PrototypeChannels.validate(channels?.objectFields, requires: requires, state: state)
        try PrototypeAuthRules.validateBlock(auth, requires: requires)
        try PrototypeSecureStorageRules.validateBlock(storage, requires: requires, state: state)
        try PrototypeLocationRules.validateBlock(location, requires: requires)
        try PrototypeMedia.validate(media, requires: requires)
        var declared = try validateRequires(requires)
        declared.channels = channels?.objectFields ?? [:]
        declared.hasAuth = auth?.objectFields != nil
        declared.secureKeys = PrototypeSecureStorageRules.secureKeys(storage)
        declared.players = PrototypeMedia.players(media)
        if let handlers { try validateHandlers(handlers, declared: declared, state: state) }
        for (handler, path) in PrototypeChannels.handlers(declared.channels) {
            if case let .array(actions) = handler { try PrototypeRequestValidator.validateList(
                actions,
                path: path,
                depth: 1,
                state: state
            ) }
            try scan(handler, path: path, inHandler: true, declared: declared, state: state)
        }
        try scan(root, path: "root", inHandler: false, declared: declared, state: state)
    }

    /// Throws at the first authored node whose `testTag` takes the host-reserved namespace.
    static func validateTestTags(nodes: [PrototypeLocatedValue]) throws {
        for node in nodes {
            guard case let .string(tag)? = node.value["testTag"], tag.hasPrefix(reservedTestTagPrefix) else {
                continue
            }
            throw PrototypeContractValidator.invalid(
                "\(node.path).testTag",
                "testTag values starting with \(reservedTestTagPrefix) are reserved for host controls"
            )
        }
    }

    // MARK: requires

    private static func validateRequires(_ raw: JSONValue?) throws -> Declared {
        var declared = Declared()
        guard let raw else { return declared }
        guard case let .object(fields) = raw else { throw fail("requires", "Expected object") }
        for key in sorted(Set(fields.keys).union(["platform", "permissions", "background"])) {
            let path = "requires.\(key)"
            guard ["platform", "permissions", "background"].contains(key) else {
                throw fail(PrototypeLimits.dataMemberPath("requires", key: key), "Unknown property")
            }
            guard let value = fields[key] else { continue }
            switch key {
            case "platform":
                let names = try strings(value, path: path, range: 1 ... 32, unique: true) { name, at in
                    guard name.utf16.count <= 64 else { throw fail(at, "Invalid string value") }
                    guard modules[name] != nil else { throw fail(at, "Unknown platform module") }
                }
                declared.modules = Set(names)
            case "permissions":
                declared.permissions = try permissions(value, path: path)
            default:
                let names = try strings(value, path: path, range: 1 ... 8, unique: true) { name, at in
                    guard backgroundNames.contains(name) else { throw fail(at, "Invalid enum value") }
                }
                declared.background = Set(names)
            }
        }
        return declared
    }

    private static func strings(
        _ raw: JSONValue, path: String, range: ClosedRange<Int>, unique: Bool,
        check: (String, String) throws -> Void
    )
        throws -> [String]
    {
        guard case let .array(items) = raw else { throw fail(path, "Expected array") }
        guard range.contains(items.count) else { throw fail(path, "Array length out of range") }
        var seen = Set<String>()
        return try items.enumerated().map { index, item in
            let at = "\(path)[\(index)]"
            guard case let .string(name) = item, !name.isEmpty else { throw fail(at, "Invalid string value") }
            try check(name, at)
            if unique, !seen.insert(name).inserted { throw fail(at, "Duplicate array value") }
            return name
        }
    }

    private static func permissions(_ raw: JSONValue, path: String) throws -> Set<String> {
        guard case let .array(items) = raw else { throw fail(path, "Expected array") }
        guard (1 ... 16).contains(items.count) else { throw fail(path, "Array length out of range") }
        var seen = Set<String>()
        for (index, item) in items.enumerated() {
            let at = "\(path)[\(index)]"
            guard case let .object(fields) = item else { throw fail(at, "Expected object") }
            for key in sorted(Set(fields.keys).union(["name", "purpose"])) {
                guard key == "name" || key == "purpose" else {
                    throw fail(PrototypeLimits.dataMemberPath(at, key: key), "Unknown property")
                }
                guard let value = fields[key] else { throw fail("\(at).\(key)", "Required property") }
                if key == "name" {
                    guard case let .string(name) = value, permissionNames.contains(name) else {
                        throw fail("\(at).name", "Invalid enum value")
                    }
                } else {
                    guard case let .string(purpose) = value, purpose.utf16.count <= 512,
                          !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    else { throw fail("\(at).purpose", "Invalid string value") }
                }
            }
        }
        // Duplicates are a separate rule the host checks after the shape, so run it after the loop.
        for (index, item) in items.enumerated() {
            guard case let .object(fields) = item, case let .string(name)? = fields["name"] else { continue }
            if !seen.insert(name).inserted { throw fail("\(path)[\(index)].name", "Duplicate permission") }
        }
        return seen
    }

    // MARK: handlers

    private static func validateHandlers(
        _ raw: JSONValue, declared: Declared, state: [String: JSONValue]
    )
        throws
    {
        guard case let .object(fields) = raw else { throw fail("platform", "Expected object") }
        for key in fields.keys where key != "on" {
            throw fail(PrototypeLimits.dataMemberPath("platform", key: key), "Unknown property")
        }
        guard let on = fields["on"] else { throw fail("platform.on", "Required property") }
        guard case let .object(handlers) = on else { throw fail("platform.on", "Expected object") }
        guard handlers.count <= maxHandlers else { throw fail("platform.on", "Record entry limit exceeded") }
        for event in sorted(Set(handlers.keys)) {
            let path = "platform.on[\(quoted(event))]"
            guard case let .array(actions)? = handlers[event] else { throw fail(path, "Expected array") }
            guard (1 ... maxActionList).contains(actions.count) else {
                throw fail(path, "Array length out of range")
            }
            guard let owner = eventModule(event) else { throw fail(path, "Unknown platform event") }
            guard declared.modules.contains(owner) else { throw notDeclared(path, owner) }
            try PrototypeRequestValidator.validateList(actions, path: path, depth: 1, state: state)
            try scan(.array(actions), path: path, inHandler: true, declared: declared, state: state)
        }
    }

    // MARK: scan

    private static func scan(
        _ value: JSONValue, path: String, inHandler: Bool, declared: Declared, state: [String: JSONValue]
    )
        throws
    {
        switch value {
        case let .array(items):
            for (index, item) in items.enumerated() {
                try scan(item, path: "\(path)[\(index)]", inHandler: inHandler, declared: declared, state: state)
            }
        case let .object(fields):
            if fields.count == 1, fields["value"] != nil { return }
            if fields["type"] == .string("pasteButton") {
                try validateCall(
                    ["type": .string("platform"), "call": .string("clipboard.paste"), "into": fields["into"] ?? .null],
                    path: path,
                    declared: declared,
                    state: state
                )
            }
            if fields["type"] == .string("platform") {
                try validateCall(fields, path: path, declared: declared, state: state)
            }
            if fields["type"] == .string("emit"), case let .string(name)? = fields["name"],
               name != PrototypeRequestEvent.name, name.hasPrefix(reservedEmitPrefix)
            {
                throw fail(
                    "\(path).name",
                    "Emit names starting with \(reservedEmitPrefix) are reserved for runtime events"
                )
            }
            try PrototypeSecureStorageRules.validateEmit(fields, path: path, secure: declared.secureKeys)
            if fields["type"] == nil {
                if case let .string(pointer)? = fields["platform"] {
                    try read(pointer, path: "\(path).platform", declared: declared)
                    try comparison(fields, pointer: pointer, path: path)
                }
                if case .string(_)? = fields["event"], !inHandler {
                    throw fail("\(path).event", "{event} is only available inside a platform.on handler")
                }
            }
            for key in sorted(Set(fields.keys)) {
                guard let member = fields[key] else { continue }
                if key == "screens", case let .object(screens) = member {
                    // Stack screens are named in brackets, as the host's screen-map walk reports them.
                    for name in sorted(Set(screens.keys)) {
                        guard let screen = screens[name] else { continue }
                        try scan(
                            screen, path: "\(path).screens[\(quoted(name))]", inHandler: inHandler,
                            declared: declared, state: state
                        )
                    }
                    continue
                }
                guard !opaqueKeys.contains(key) else { continue }
                let memberPath = PrototypeLimits.dataMemberPath(path, key: key)
                if textKeys.contains(key), case let .string(text) = member {
                    for pointer in placeholders(text) {
                        try read(pointer, path: memberPath, declared: declared)
                    }
                }
                try scan(member, path: memberPath, inHandler: inHandler, declared: declared, state: state)
            }
        default:
            break
        }
    }

    private static func read(_ pointer: String, path: String, declared: Declared) throws {
        guard PrototypeDataPointer.isValid(pointer) else { throw fail(path, "Invalid pointer value") }
        let name = PrototypeDataPointer.tokens(pointer).first ?? ""
        guard modules[name] != nil else { throw fail(path, "Unknown platform module \(name)") }
        guard declared.modules.contains(name) else { throw notDeclared(path, name) }
        if let state = modules[name]?.state {
            let tokens = PrototypeDataPointer.tokens(pointer)
            let valid = switch name {
            case "realtime": tokens.count == 3 && declared.channels[tokens[1]] != nil && state.contains(tokens[2])
            case "media": PrototypeMedia.validRead(tokens, players: declared.players, state: state)
            default: tokens.count == 2 && state.contains(tokens[1])
            }
            guard valid else {
                throw fail(path, "Unknown platform state \(pointer)")
            }
        }
    }

    /// Portable specs can branch on device.os; these validators have no target-platform input.
    private static func comparison(_ fields: [String: JSONValue], pointer: String, path: String) throws {
        let tokens = PrototypeDataPointer.tokens(pointer)
        guard tokens.count == 2,
              let entry = PrototypeContractValidator.platformModules[tokens[0]]?.objectFields?["state"]?
              .objectFields?[tokens[1]]?.objectFields,
              let overrides = entry["valueByPlatform"]?.objectFields, let base = entry["value"]
        else { return }
        let rule = JSONValue.object(["kind": .string("choice"), "options": .array([base] + Array(overrides.values))])
        for operation in ["equals", "notEquals"] {
            guard let literal = fields[operation] else { continue }
            do {
                try PrototypeContractValidator.validateValue(literal, rule: rule, path: "\(path).\(operation)")
            } catch let PrototypeLoadError.invalidSpec(path, message) {
                throw fail(path, message)
            }
        }
    }

    // MARK: call

    private static func validateCall(
        _ action: [String: JSONValue], path: String, declared: Declared, state: [String: JSONValue]
    )
        throws
    {
        for key in sorted(Set(action.keys)) where !actionFields.contains(key) {
            throw fail(PrototypeLimits.dataMemberPath(path, key: key), "Unknown property")
        }
        guard case let .string(call)? = action["call"], (1 ... 64).contains(call.utf16.count) else {
            throw fail("\(path).call", "Invalid string value")
        }
        if let timeout = action["timeoutMs"] {
            guard case let .number(value) = timeout, value == value.rounded(),
                  (1 ... Double(maxTimeoutMs)).contains(value)
            else { throw fail("\(path).timeoutMs", "Invalid number value") }
        }
        for list in ["onSuccess", "onError"] {
            guard let raw = action[list] else { continue }
            guard case let .array(entries) = raw, (1 ... maxActionList).contains(entries.count) else {
                throw fail("\(path).\(list)", "Array length out of range")
            }
        }
        let args = try arguments(action["args"], path: "\(path).args", realtime: call.hasPrefix("realtime."))
        guard let parts = qualified(call), let definition = modules[parts.module]?.calls[parts.member] else {
            throw fail("\(path).call", "Unknown platform call")
        }
        let owner = parts.module
        guard declared.modules.contains(owner) else { throw notDeclared("\(path).call", owner) }
        if let missing = definition.permissions.first(where: { !declared.permissions.contains($0) }) {
            throw fail("\(path).call", "Platform call \(call) requires permission \(missing) in requires.permissions")
        }
        if let missing = definition.background.first(where: { !declared.background.contains($0) }) {
            throw fail("\(path).call", "Platform call \(call) requires \(missing) in requires.background")
        }
        for name in sorted(Set(definition.args.keys).union(args.keys)) {
            let at = PrototypeLimits.dataMemberPath("\(path).args", key: name)
            guard let argument = definition.args[name] else { throw fail(
                at,
                call == "share.open" && name == "title" ? "Unknown argument: use subject" : "Unknown argument"
            ) }
            guard let binding = args[name] else {
                if argument.optional { continue }
                throw fail(at, "Required argument")
            }
            if call == "share.open", ["text", "url", "subject"].contains(name) { continue }
            if case let .object(form) = binding, let literal = form["value"] {
                try check(literal, argument.rule, path: "\(at).value")
            }
        }
        try PrototypeChannels.call(action, path: path, channels: declared.channels)
        try PrototypeAuthRules.validateCall(call, path: path, hasAuth: declared.hasAuth)
        try PrototypeMedia.call(action, path: path, players: declared.players)
        if call == "share.open", let error = PrototypeShare.argumentsError(args, path: "\(path).args") {
            throw fail(error.path, error.message)
        }
        if call == "links.open", let error = PrototypeLinks.argumentsError(args, path: "\(path).args") {
            throw fail(error.path, error.message)
        }
        if let into = action["into"] { try self.into(into, path: "\(path).into") }
        try statusKey(action["statusKey"], path: "\(path).statusKey", state: state)
    }

    private static func arguments(_ raw: JSONValue?, path: String, realtime: Bool) throws -> [String: JSONValue] {
        guard let raw else { return [:] }
        guard case let .object(fields) = raw else { throw fail(path, "Expected object") }
        guard fields.count <= maxArgs else { throw fail(path, "Record entry limit exceeded") }
        for name in sorted(Set(fields.keys)) {
            let at = PrototypeLimits.dataMemberPath(path, key: name)
            if fields[name]?.stringValue != nil {
                if realtime, name == "channel" { continue }
                throw fail(at, "Invalid union value")
            }
            // An unknown key inside a one-key form is reported at that key, as the TypeScript walk does.
            if case let .object(form)? = fields[name], form.count == 1, let key = form.keys.first,
               !bindingKeys.contains(key)
            {
                throw fail(PrototypeLimits.dataMemberPath(at, key: key), "Unknown property")
            }
            guard case let .object(form)? = fields[name], form.count == 1, let key = form.keys.first,
                  bindingKeys.contains(key), key != "index" || form[key] == .bool(true)
            else { throw fail(at, "Invalid union value") }
        }
        return fields
    }

    static func check(_ literal: JSONValue, _ rule: Rule, path: String) throws {
        switch rule {
        case let .json(maxBytes):
            let encoder = JSONEncoder()
            encoder.outputFormatting = .withoutEscapingSlashes
            guard let bytes = try? encoder.encode(literal), bytes.count <= maxBytes else {
                throw fail(path, "Invalid json value")
            }
        case let .string(rule):
            // The shared contract rule honours empty, nonblank, min, max, maxBytes and pattern.
            guard literal.stringValue != nil, PrototypeContractValidator.primitive(literal, rule: rule) else {
                throw fail(path, "Invalid string value")
            }
        case .boolean:
            guard literal.boolValue != nil else { throw fail(path, "Invalid boolean value") }
        case let .integer(min, max):
            guard case let .number(value) = literal, value == value.rounded(), (min ... max).contains(value) else {
                throw fail(path, "Invalid number value")
            }
        case let .enumeration(values):
            guard case let .string(value) = literal, values.contains(value) else {
                throw fail(path, "Invalid enum value")
            }
        case let .contract(rule):
            do {
                try PrototypeContractValidator.validateValue(literal, rule: rule, path: path)
            } catch let error as PrototypeLoadError {
                guard case let .invalidSpec(at, message) = error else { throw error }
                throw fail(at, message)
            }
        }
    }

    /// The host's `into` rule: a `/data` object member; `/platform` is read-only.
    private static func into(_ raw: JSONValue, path: String) throws {
        let message = "platform into is /data/<RFC 6901 pointer> and addresses a member of data"
        guard case let .string(text) = raw else { throw fail(path, message) }
        if text == "/platform" || text.hasPrefix("/platform/") {
            throw fail(path, "/platform is read-only: write a platform call result into /data")
        }
        let bound = text.split(separator: "/", omittingEmptySubsequences: false)
            .map { $0 == "{index}" ? "0" : String($0) }.joined(separator: "/")
        guard let pointer = PrototypeDataWrite.pointer(ofPath: bound) else { throw fail(path, message) }
        let last = pointer.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        if last == "-" || (!last.isEmpty && last.allSatisfy { $0.isASCII && $0.isNumber }) {
            throw fail(
                path,
                "platform into must name an object member, not an array element, so into__meta can be written beside it"
            )
        }
    }

    /// A declared string state key; a key holding a placeholder is bound per repeat row.
    private static func statusKey(_ raw: JSONValue?, path: String, state: [String: JSONValue]) throws {
        guard let raw else { return }
        guard case let .string(key) = raw, !key.isEmpty else { throw fail(path, "Invalid key value") }
        guard !key.contains("{") else { return }
        guard let stored = state[key] else { throw fail(path, "statusKey must name a declared state key") }
        guard stored.stringValue != nil else { throw fail(path, "statusKey requires a string state key") }
    }

    // MARK: helpers

    private static func qualified(_ name: String) -> (module: String, member: String)? {
        guard let dot = name.firstIndex(of: "."), dot != name.startIndex,
              name.index(after: dot) != name.endIndex
        else { return nil }
        return (String(name[..<dot]), String(name[name.index(after: dot)...]))
    }

    private static func eventModule(_ event: String) -> String? {
        guard let parts = qualified(event), modules[parts.module]?.events.contains(parts.member) == true else {
            return nil
        }
        return parts.module
    }

    /// `{platform:/pointer}` placeholders, scanned exactly as `{data:/pointer}` ones.
    static func placeholders(_ text: String) -> [String] {
        let units = Array(text.utf16)
        let prefix = Array("platform:".utf16)
        var found: [String] = []
        var cursor = 0
        while cursor < units.count {
            guard units[cursor] == 123, units.count > cursor + prefix.count,
                  Array(units[(cursor + 1) ... (cursor + prefix.count)]) == prefix
            else {
                cursor += 1
                continue
            }
            let end = min(units.count, cursor + 2 + prefix.count + PrototypeLimits.maxDataPointerLength)
            let close = (cursor + 1 ..< end).first { units[$0] == 125 }
            let pointer = close.map {
                String(decoding: units[(cursor + 1 + prefix.count) ..< $0], as: UTF16.self)
            } ?? ""
            if let close, PrototypeDataPointer.isValid(pointer) {
                found.append(pointer)
                cursor = close + 1
            } else {
                cursor += 1
            }
        }
        return found
    }

    private static func sorted(_ keys: Set<String>) -> [String] {
        keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    }

    private static func quoted(_ name: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        return (try? encoder.encode(name)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }

    private static func notDeclared(_ path: String, _ name: String) -> DecodingError {
        fail(path, "Platform module \(name) is not declared in requires.platform")
    }

    private static func fail(_ path: String, _ message: String) -> DecodingError {
        PrototypeLimits.violation(path, message)
    }
}
