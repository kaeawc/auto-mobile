import Foundation

/// Foundation owns JSON grammar. This preflight detects duplicate keys and bounds nesting before
/// Foundation recurses. UTF-16 arrays preserve exact member identity rather than Swift's NFC equality.
enum PrototypeStrictJSON {
    static func prepare(_ data: Data) throws -> Data {
        guard data.count <= PrototypeLimits.maxSpecBytes, let text = String(data: data, encoding: .utf8) else {
            throw PrototypeContractValidator.invalid("$", "Invalid UTF-8 or spec byte limit exceeded")
        }
        let source = text.unicodeScalars.first == "\u{FEFF}" ? String(text.unicodeScalars.dropFirst()) : text
        let bytes = Array(source.utf8)
        var cursor = 0
        var stack: [Set<[UInt16]>?] = []
        while cursor < bytes.count {
            let char = bytes[cursor]
            cursor += 1
            if char == 34 {
                let start = cursor - 1
                while cursor < bytes.count {
                    let next = bytes[cursor]
                    cursor += 1
                    if next == 92 { cursor += 1 }
                    else if next == 34 { break }
                }
                guard cursor <= bytes.count else { throw PrototypeContractValidator.invalid("$", "Invalid JSON") }
                let token: String
                do { token = try JSONDecoder().decode(String.self, from: Data(bytes[start ..< cursor])) }
                catch { throw PrototypeContractValidator.invalid("$", "Invalid JSON string") }
                var after = cursor
                while after < bytes.count, [9, 10, 13, 32].contains(bytes[after]) {
                    after += 1
                }
                if after < bytes.count, bytes[after] == 58, let last = stack.indices.last, var keys = stack[last] {
                    guard keys.insert(Array(token.utf16)).inserted else { throw PrototypeContractValidator.invalid(
                        "$",
                        "Duplicate JSON key"
                    ) }
                    stack[last] = keys
                }
            } else if char == 123 || char == 91 {
                stack.append(char == 123 ? [] : nil)
                if stack.count > 128 { throw PrototypeContractValidator.invalid("$", "JSON nesting limit exceeded") }
            } else if char == 125 || char == 93 {
                if !stack.isEmpty { stack.removeLast() }
            } else if char == 45 || (48 ... 57).contains(char) {
                let start = cursor - 1
                while cursor < bytes.count, ![9, 10, 13, 32, 44, 93, 125, 58].contains(bytes[cursor]) {
                    cursor += 1
                }
                if let number = Double(String(decoding: bytes[start ..< cursor], as: UTF8.self)), !number.isFinite {
                    throw PrototypeContractValidator.invalid("$", "Nonfinite JSON number")
                }
            }
        }
        return Data(source.utf8)
    }
}
