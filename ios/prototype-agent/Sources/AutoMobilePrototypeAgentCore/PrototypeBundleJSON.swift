import Foundation

/// Foundation owns JSON grammar, escapes and values. This bounded token walk adds exact-key
/// duplicate rejection and depth checks, and retains object order for advisory warning paths.
struct PrototypeBundleJSON {
    let value: JSONValue
    let data: Data
    let objectKeys: [String: [String]]

    init(_ bytes: Data, code: PrototypeBundleCode, path: String) throws {
        do {
            guard var text = String(data: bytes, encoding: .utf8) else { throw PrototypeBundleFailure(code, path) }
            if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
            data = Data(text.utf8)
            var scanner = BundleJSONKeyScanner(bytes: Array(data))
            try scanner.value(depth: 0, path: "$")
            objectKeys = scanner.keys
            value = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw PrototypeBundleFailure(code, path)
        }
    }
}

private struct BundleJSONKeyScanner {
    let bytes: [UInt8]
    var offset = 0
    var keys: [String: [String]] = [:]
    private var current: UInt8? { offset < bytes.count ? bytes[offset] : nil }
    private func invalid() -> PrototypeBundleFailure { PrototypeBundleFailure(.specInvalidJSON) }

    mutating func space() { while let byte = current, [9, 10, 13, 32].contains(byte) {
        offset += 1
    } }
    mutating func take(_ byte: UInt8) throws {
        space()
        guard current == byte else { throw invalid() }
        offset += 1
    }

    mutating func string() throws -> String {
        let start = offset
        try take(34)
        while let byte = current {
            offset += 1
            if byte == 34 { return try JSONDecoder().decode(String.self, from: Data(bytes[start ..< offset])) }
            if byte == 92 {
                guard current != nil else { throw invalid() }
                offset += 1
            }
        }
        throw invalid()
    }

    mutating func value(depth: Int, path: String) throws {
        guard depth <= PrototypeBundle.maxJSONDepth else { throw invalid() }
        space()
        switch current {
        case 123: try object(depth: depth, path: path)
        case 91:
            offset += 1
            space()
            var index = 0
            if current != 93 {
                while true {
                    try value(depth: depth + 1, path: "\(path).\(index)")
                    index += 1
                    space()
                    if current != 44 { break }
                    offset += 1
                }
            }
            try take(93)
        case 34: _ = try string()
        default:
            let start = offset
            while let byte = current, ![9, 10, 13, 32, 44, 93, 125].contains(byte) {
                offset += 1
            }
            guard offset > start else { throw invalid() }
        }
    }

    mutating func object(depth: Int, path: String) throws {
        offset += 1
        space()
        var seen = Set<Data>()
        var ordered: [String] = []
        if current != 125 {
            while true {
                space()
                let key = try string()
                guard seen.insert(Data(key.utf8)).inserted else { throw invalid() }
                ordered.append(key)
                try take(58)
                try value(depth: depth + 1, path: "\(path).\(key)")
                space()
                if current != 44 { break }
                offset += 1
            }
        }
        try take(125)
        // Object.keys puts canonical uint32 indices first, independently of source order.
        let indexed = ordered.compactMap { key -> (String, Int)? in
            guard let index = PrototypeDataPointer.arrayIndex(key), index < Int(UInt32.max) else { return nil }
            return (key, index)
        }
        let indexKeys = Set(indexed.map { $0.0 })
        keys[path] = indexed.sorted { $0.1 < $1.1 }.map { $0.0 } + ordered.filter { !indexKeys.contains($0) }
    }
}
