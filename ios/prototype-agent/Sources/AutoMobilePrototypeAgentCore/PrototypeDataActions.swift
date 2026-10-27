import Foundation

/// Why a device data write changed nothing. The codes are the wire names of
/// `PrototypeDataWriteErrorCode` in `src/features/prototype/prototypeDataWrite.ts`.
enum PrototypeDataWriteCode: String, Equatable {
    case invalidPath = "invalid_path"
    case invalidValue = "invalid_value"
    case notFound = "not_found"
    case notArray = "not_array"
    case limitExceeded = "limit_exceeded"
}

struct PrototypeDataWriteFailure: Error, Equatable {
    let code: PrototypeDataWriteCode
    let message: String
}

/// The device side of `setData`, `appendData` and `removeData` (#12519): a Swift twin of the pure
/// `applyPrototypeDataWrite` and `resolvePrototypeDataWriteValue` helpers, so the host mirror and
/// this runtime cannot drift. Nothing here touches a session; a refused write returns a failure and
/// the input is untouched.
enum PrototypeDataWrite {
    enum Operation: String, Equatable {
        case set
        case append
        case remove

        init?(actionType: String) {
            switch actionType {
            case "setData": self = .set
            case "appendData": self = .append
            case "removeData": self = .remove
            default: return nil
            }
        }
    }

    static let actionTypes: Set<String> = ["setData", "appendData", "removeData"]

    /// The pointer of a `/data/<pointer>` path: `/data` alone (the whole document) has none.
    static func pointer(ofPath path: String) -> String? {
        guard path.utf16.starts(with: "/data/".utf16) else { return nil }
        let pointer = String(decoding: Array(path.utf16.dropFirst("/data".utf16.count)), as: UTF16.self)
        return PrototypeDataPointer.isValid(pointer) ? pointer : nil
    }

    // MARK: Value

    /// `{value}` is the literal, `{state}` and `{data}` read the committed values at the action. A
    /// missing source is an error. `{item}` and `{index}` are bound by repeat expansion before an
    /// action runs, so one left here was written outside a repeat. `page` is not a data binding.
    static func resolveValue(
        _ binding: JSONValue?, inputs: some PrototypeEmitContextInputs
    )
        -> Result<JSONValue, PrototypeDataWriteFailure>
    {
        guard let binding,
              let bindings = try? PrototypeEmitContext.validate(.object(["value": binding]), path: "value"),
              case let .object(form)? = bindings["value"], form.count == 1, let kind = form.keys.first
        else {
            return .failure(.init(code: .invalidValue, message: "A set or append write needs a value binding"))
        }
        switch (kind, form[kind]) {
        case let ("value", literal?):
            return .success(literal)
        case let ("state", key?):
            guard let key = key.stringValue, let value = inputs.state(key) else {
                return .failure(.init(
                    code: .invalidValue,
                    message: "State key \(form[kind]?.stringValue ?? "") is not set"
                ))
            }
            return .success(value)
        case let ("data", pointer?):
            guard let pointer = pointer.stringValue, let value = inputs.data(pointer) else {
                return .failure(.init(
                    code: .notFound, message: "Data pointer \(form[kind]?.stringValue ?? "") does not exist"
                ))
            }
            return .success(value)
        case let (kind, pointer?) where kind == "platform" || kind == "event":
            guard let pointer = pointer.stringValue,
                  let value = kind == "platform" ? inputs.platform(pointer) : inputs.event(pointer)
            else {
                return .failure(.init(code: .notFound, message: "Binding pointer does not exist"))
            }
            return .success(value)
        default:
            return .failure(.init(code: .invalidValue, message: "A data write value cannot use \(kind) here"))
        }
    }

    // MARK: Write

    /// Applies one write to `data` (absent data is an empty object). `set` creates or replaces an
    /// object member and replaces an existing array element; `append` pushes onto an existing array;
    /// `remove` deletes an existing member or element and later elements shift down. The result must
    /// satisfy the data limits, including `maxDataWriteBytes`, or nothing is written.
    static func apply(
        _ data: [String: JSONValue]?, op operation: Operation, path: String, value: JSONValue?
    )
        -> Result<[String: JSONValue], PrototypeDataWriteFailure>
    {
        guard let pointer = pointer(ofPath: path) else {
            return fail(.invalidPath, "\(path) is not a /data/<pointer> path")
        }
        if operation != .remove, value == nil { return fail(.invalidValue, "A set or append write needs a value") }
        let current = data ?? [:]
        let tokens = PrototypeDataPointer.tokens(pointer)
        let existing = PrototypeDataPointer.resolve(.object(current), tokens: tokens[...])
        if let refusal = targetRefusal(current, tokens: tokens, existing: existing, op: operation, path: path) {
            return .failure(refusal)
        }
        guard case let .object(next)? = mutate(.object(current), tokens: tokens[...], op: operation, value: value)
        else {
            return fail(.notFound, "\(path): the target cannot be written")
        }
        do {
            try PrototypeLimits.guardDataWrite(next)
        } catch {
            // Only the limit walk throws here; its messages name the limit when one was exceeded.
            let message = "\(error)"
            return fail(
                message.contains("limit") ? .limitExceeded : .invalidValue,
                "\(path): \(message)"
            )
        }
        return .success(next)
    }

    private static func fail(
        _ code: PrototypeDataWriteCode, _ message: String
    )
        -> Result<[String: JSONValue], PrototypeDataWriteFailure>
    {
        .failure(.init(code: code, message: message))
    }

    private static func targetRefusal(
        _ data: [String: JSONValue], tokens: [String], existing: JSONValue?, op operation: Operation, path: String
    )
        -> PrototypeDataWriteFailure?
    {
        switch operation {
        case .append:
            guard let existing
            else { return .init(code: .notFound, message: "appendData target \(path) does not exist") }
            if case .array = existing { return nil }
            return .init(code: .notArray, message: "appendData target \(path) is not an array")
        case .remove:
            return existing == nil
                ? .init(code: .notFound, message: "removeData target \(path) does not exist") : nil
        case .set:
            // An array element is replaced, never created: appending is appendData's job.
            let parent = tokens.count == 1
                ? JSONValue.object(data)
                : PrototypeDataPointer.resolve(.object(data), tokens: tokens.dropLast())
            let refused: Bool = switch parent {
            case .array?: existing == nil
            case .object?: false
            default: true
            }
            return refused
                ? .init(code: .notFound, message: "setData target \(path) has no existing parent or element") : nil
        }
    }

    private static func mutateObject(
        _ original: [String: JSONValue],
        token: String,
        tokens: ArraySlice<String>,
        last: Bool,
        op operation: Operation,
        value: JSONValue?
    )
        -> JSONValue?
    {
        var fields = original
        let key = PrototypeDataPointer.exactKey(token, in: fields).map { fields[$0].key }
        if last {
            guard let written = leaf(fields[key ?? token], present: key != nil, op: operation, value: value) else {
                return nil
            }
            fields.removeValue(forKey: key ?? token)
            if let written { fields[token] = written }
        } else {
            guard let key, let child = fields[key],
                  let next = mutate(child, tokens: tokens.dropFirst(), op: operation, value: value)
            else { return nil }
            fields[key] = next
        }
        return .object(fields)
    }

    /// The tree with the write made at `tokens`, or nil when a step is missing. Object members are
    /// matched on exact UTF-16 keys; a `set` removes first so an equivalent spelling is replaced.
    private static func mutate(
        _ node: JSONValue,
        tokens: ArraySlice<String>,
        op operation: Operation,
        value: JSONValue?
    )
        -> JSONValue?
    {
        guard let token = tokens.first else { return nil }
        let last = tokens.count == 1
        switch node {
        case let .object(fields):
            return mutateObject(fields, token: token, tokens: tokens, last: last, op: operation, value: value)
        case var .array(items):
            guard let index = PrototypeDataPointer.arrayIndex(token), items.indices.contains(index) else { return nil }
            if last {
                guard let written = leaf(items[index], present: true, op: operation, value: value) else { return nil }
                if let written { items[index] = written } else { items.remove(at: index) }
            } else {
                guard let next = mutate(items[index], tokens: tokens.dropFirst(), op: operation, value: value) else {
                    return nil
                }
                items[index] = next
            }
            return .array(items)
        default:
            return nil
        }
    }

    /// What replaces the target: `.some(value)` stores it, `.some(nil)` deletes it, nil is a refusal.
    private static func leaf(
        _ old: JSONValue?,
        present: Bool,
        op operation: Operation,
        value: JSONValue?
    )
        -> JSONValue??
    {
        switch operation {
        case .set:
            return value.map { .some($0) }
        case .append:
            guard present, case var .array(items)? = old, let value else { return nil }
            items.append(value)
            return .some(.array(items))
        case .remove:
            return present ? .some(nil) : nil
        }
    }
}

extension PrototypeDataWrite {
    /// Static authored-action checks, sharing the runtime's pointer and value limits.
    static func validate(actions: [PrototypeLocatedValue], data: [String: JSONValue]?) throws {
        for action in actions {
            let fields = action.value
            guard ["setData", "appendData", "removeData"].contains(fields["type"]?.stringValue ?? "") else { continue }
            let path = fields["path"]?.stringValue ?? ""
            let bound = path.split(separator: "/", omittingEmptySubsequences: false)
                .map { $0 == "{index}" ? "0" : String($0) }.joined(separator: "/")
            guard let pointer = pointer(ofPath: bound) else { throw PrototypeContractValidator.invalid(
                "\(action.path).path",
                "Invalid data write path"
            ) }
            if let literal = fields["value"]?.objectFields?["value"] {
                do { try PrototypeLimits.guardDataWrite(["value": literal]) }
                catch { throw PrototypeContractValidator.invalid(
                    "\(action.path).value.value",
                    "Invalid data write value"
                ) }
            }
            if fields["type"] == .string("appendData"), !path.contains("{index}"),
               let value = PrototypeDataPointer.resolve(data, pointer: pointer)
            {
                guard case .array = value else { throw PrototypeContractValidator.invalid(
                    "\(action.path).path",
                    "appendData needs array"
                ) }
            }
        }
    }
}
