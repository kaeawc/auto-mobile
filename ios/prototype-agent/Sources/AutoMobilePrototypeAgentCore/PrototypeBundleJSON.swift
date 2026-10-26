import Foundation

/// Foundation owns JSON grammar, escapes and values. This bounded token walk adds exact-key
/// duplicate rejection and depth checks, and retains object order for advisory warning paths.
struct PrototypeBundleJSON {
    let value: JSONValue
    let data: Data
    let objectKeys: [String: [String]]

    /// `valueFailure` is the code for text that is valid JSON to JavaScript (lone `\u` surrogates,
    /// doubles that overflow) but that Foundation cannot represent; TS reports those at validation.
    init(_ bytes: Data, code: PrototypeBundleCode, path: String, valueFailure: PrototypeBundleCode? = nil) throws {
        let repaired: PrototypeBundleJSONRepair
        do {
            // Foundation's String(data:) also drops a leading BOM, so strip exactly one by hand.
            let bom: [UInt8] = [0xEF, 0xBB, 0xBF]
            let body = bytes.starts(with: bom) ? bytes.dropFirst(bom.count) : bytes[...]
            guard !body.starts(with: bom), let text = String(data: Data(body), encoding: .utf8) else {
                throw PrototypeBundleFailure(code, path)
            }
            var scanner = BundleJSONKeyScanner(bytes: Array(text.utf8))
            try scanner.value(depth: 0, path: "$")
            objectKeys = scanner.keys
            repaired = PrototypeBundleJSONRepair(Data(text.utf8))
            guard let decoded = try? JSONDecoder().decode(JSONValue.self, from: repaired.data) else {
                throw PrototypeBundleFailure(code, path)
            }
            value = decoded
            data = repaired.data
        } catch {
            throw PrototypeBundleFailure(code, path)
        }
        if repaired.unrepresentable { throw PrototypeBundleFailure(valueFailure ?? code, path) }
    }
}

/// JavaScript's JSON.parse accepts text Foundation's decoder refuses: unpaired `\u` surrogates and
/// numbers outside the Double range. Underflow becomes a signed zero (as in TS); the others are
/// substituted so grammar can still be judged, and reported through `unrepresentable`.
struct PrototypeBundleJSONRepair {
    private(set) var data: Data
    private(set) var unrepresentable = false

    init(_ input: Data) {
        let bytes = [UInt8](input)
        var out = [UInt8]()
        out.reserveCapacity(bytes.count)
        var index = 0
        var inString = false
        while index < bytes.count {
            let byte = bytes[index]
            if inString {
                if byte == 34 { inString = false }
                if byte == 92 {
                    index += Self.copyEscape(bytes, index, into: &out, flag: &unrepresentable)
                    continue
                }
            } else if byte == 34 {
                inString = true
            } else if byte == 45 || (48 ... 57).contains(byte) {
                index += Self.copyNumber(bytes, index, into: &out, flag: &unrepresentable)
                continue
            }
            out.append(byte)
            index += 1
        }
        data = Data(out)
    }

    private static func isNumberByte(_ byte: UInt8) -> Bool {
        (48 ... 57).contains(byte) || [43, 45, 46, 69, 101].contains(byte)
    }

    private static func copyNumber(_ bytes: [UInt8], _ start: Int, into out: inout [UInt8], flag: inout Bool) -> Int {
        var end = start
        while end < bytes.count, isNumberByte(bytes[end]) {
            end += 1
        }
        let token = Array(bytes[start ..< end])
        let parsed = String(bytes: token, encoding: .utf8).flatMap(Double.init)
        guard let number = parsed, number == 0 || !number.isFinite else {
            out.append(contentsOf: token)
            return end - start
        }
        let mantissa = token.prefix { $0 != 69 && $0 != 101 }
        if !number.isFinite {
            flag = true
            out.append(48)
        } else if mantissa.contains(where: { (49 ... 57).contains($0) }) {
            out.append(contentsOf: token.first == 45 ? [45, 48] : [48]) // underflow keeps its sign
        } else {
            out.append(contentsOf: token)
        }
        return end - start
    }

    private static func hex(_ bytes: [UInt8], _ start: Int) -> UInt32? {
        guard start + 4 <= bytes.count else { return nil }
        return bytes[start ..< start + 4].reduce(into: UInt32?.some(0)) { value, byte in
            let digit = (48 ... 57).contains(byte) ? byte - 48
                : (97 ... 102).contains(byte) ? byte - 87 : (65 ... 70).contains(byte) ? byte - 55 : nil
            value = value.flatMap { running in digit.map { running << 4 | UInt32($0) } }
        }
    }

    /// Copies the escape at `start` (a backslash); an unpaired surrogate escape becomes U+FFFD.
    private static func copyEscape(_ bytes: [UInt8], _ start: Int, into out: inout [UInt8], flag: inout Bool) -> Int {
        guard start + 1 < bytes.count else {
            out.append(92)
            return 1
        }
        guard bytes[start + 1] == 117, let unit = hex(bytes, start + 2), (0xD800 ... 0xDFFF).contains(unit) else {
            out.append(contentsOf: bytes[start ... start + 1])
            return 2
        }
        let paired = unit < 0xDC00 && start + 11 < bytes.count && bytes[start + 6] == 92 && bytes[start + 7] == 117 &&
            hex(bytes, start + 8).map { (0xDC00 ... 0xDFFF).contains($0) } == true
        if paired {
            out.append(contentsOf: bytes[start ..< start + 12])
            return 12
        }
        flag = true
        out.append(contentsOf: Array(#"\uFFFD"#.utf8))
        return 6
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
            if byte == 34 {
                // Foundation refuses unpaired surrogate escapes that JSON.parse accepts. Keep the raw
                // token as the key; the full decode below is what judges grammar.
                return (try? JSONDecoder().decode(String.self, from: Data(bytes[start ..< offset])))
                    ?? String(bytes: bytes[start ..< offset], encoding: .utf8) ?? ""
            }
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
