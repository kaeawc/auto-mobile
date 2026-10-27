import Foundation

struct PrototypeRequestAppend: Decodable, Equatable {
    let from: String
    let to: String
    var maxItems: Double? = nil
}

extension PrototypeRequestOutcome {
    struct Applied {
        let status: String
        let data: [String: JSONValue]
        let meta: PrototypeRequestMeta
        let wroteInto: Bool
        let appended: Int
    }

    static func apply(
        _ data: [String: JSONValue], into: String?, response: PrototypeRequestResponse,
        append: PrototypeRequestAppend? = nil
    )
        -> Applied
    {
        var meta = PrototypeRequestMeta(response)
        var next = data
        var wroteInto = false
        var appended = 0
        if case let .received(_, _, body, _) = response, meta.error == nil {
            switch writeResponse(data, into: into, body: body, append: append) {
            case let .success(written):
                next = written.data
                appended = written.appended
                wroteInto = into != nil
            case let .failure(error):
                meta.error = error
            }
        }
        if let into {
            if let withMeta = writeMeta(next, into: into, meta: meta) {
                next = withMeta
            } else if wroteInto || next != data {
                meta.error = .init(.invalidResponse, noRoomForMeta)
                wroteInto = false
                appended = 0
                next = writeMeta(data, into: into, meta: meta, minimal: true) ?? data
            }
        }
        return Applied(
            status: meta.error == nil ? "success" : "error",
            data: next,
            meta: meta,
            wroteInto: wroteInto,
            appended: appended
        )
    }

    private struct Written {
        let data: [String: JSONValue]
        let appended: Int
    }

    private static func writeResponse(
        _ data: [String: JSONValue], into: String?, body: JSONValue, append: PrototypeRequestAppend?
    )
        -> Result<Written, PrototypeRequestError>
    {
        var next = data
        var rest = body
        var appended = 0
        if let append {
            let tokens = PrototypeDataPointer.tokens(append.from)
            guard PrototypeDataPointer.isValid(append.from), tokens.last != nil,
                  case let .array(items)? = PrototypeDataPointer.resolve(body, tokens: tokens[...]),
                  case .object? = PrototypeDataPointer.resolve(body, tokens: tokens.dropLast()),
                  let removed = removing(body, tokens: tokens[...])
            else {
                return .failure(.init(
                    .invalidResponse,
                    "append.from does not resolve to an array in the response"
                ))
            }
            switch PrototypeDataWrite.applyWindowed(
                next,
                op: .extend,
                path: append.to,
                value: .array(items),
                maxItems: append.maxItems
            ) {
            case let .success(written): next = written.data
            case let .failure(error): return .failure(.init(.invalidResponse, "append.to \(error.message)"))
            }
            rest = removed
            appended = items.count
        }
        if let into {
            switch PrototypeDataWrite.apply(next, op: .set, path: into, value: rest == .null ? .string("") : rest) {
            case let .success(written): next = written
            case let .failure(error): return .failure(.init(.invalidResponse, error.message))
            }
        }
        return .success(Written(data: next, appended: appended))
    }

    /// Value-semantic removal also supports an object member reached through an intermediate array.
    private static func removing(_ value: JSONValue, tokens: ArraySlice<String>) -> JSONValue? {
        guard let token = tokens.first else { return nil }
        switch value {
        case var .object(fields):
            guard let index = PrototypeDataPointer.exactKey(token, in: fields) else { return nil }
            let exact = fields[index].key
            if tokens.count == 1 { fields.removeValue(forKey: exact) }
            else {
                guard let child = fields[exact],
                      let next = removing(child, tokens: tokens.dropFirst()) else { return nil }
                fields[exact] = next
            }
            return .object(fields)
        case var .array(items):
            guard tokens.count > 1, let index = PrototypeDataPointer.arrayIndex(token), items.indices.contains(index),
                  let next = removing(items[index], tokens: tokens.dropFirst()) else { return nil }
            items[index] = next
            return .array(items)
        default: return nil
        }
    }

    private static func writeMeta(
        _ data: [String: JSONValue], into: String, meta: PrototypeRequestMeta, minimal: Bool = false
    )
        -> [String: JSONValue]?
    {
        var forms = [meta.json()]
        if meta.headers != nil { forms.append(meta.json(includingHeaders: false)) }
        if minimal, let error = meta.error {
            forms.append(.object(["durationMs": .number(Double(meta.durationMs)), "error": error.json]))
        }
        for value in forms {
            if case let .success(written) = PrototypeDataWrite.apply(
                data,
                op: .set,
                path: into + "__meta",
                value: value
            ) {
                return written
            }
        }
        return nil
    }
}
