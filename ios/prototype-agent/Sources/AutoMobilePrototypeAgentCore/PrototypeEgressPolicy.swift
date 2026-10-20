import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

/// Pure destination classification. DNS answers and connection addresses use the same rules.
struct PrototypeEgressPolicy: Sendable {
    enum Decision: Equatable, Sendable {
        case allow
        case block
    }

    let daemonPorts: Set<Int>

    init(daemonPorts: Set<Int> = Set(3000 ... 3010).union([8765])) {
        self.daemonPorts = daemonPorts
    }

    /// Names require at least one DNS answer. Every supplied answer must be an IP literal
    /// and must pass the policy; a literal host can be classified without DNS.
    func check(host: String, port: Int, addresses: [String]) -> Decision {
        guard checkHost(host: host, port: port) == .allow,
              Self.isIPLiteral(host) || !addresses.isEmpty,
              addresses.allSatisfy({ checkHost($0, port: port, requiresIP: true) }) else { return .block }
        return .allow
    }

    /// The host-only preflight runs before resolving a name. It does not authorize a connection.
    func checkHost(host: String, port: Int) -> Decision {
        (1 ... 65535).contains(port) && checkHost(host, port: port, requiresIP: false) ? .allow : .block
    }

    static func isIPLiteral(_ host: String) -> Bool {
        let host = normalized(host)
        return ipv4(host) != nil || ipv6(host) != nil
    }

    private func checkHost(_ raw: String, port: Int, requiresIP: Bool) -> Bool {
        let host = Self.normalized(raw)
        guard !host.isEmpty, !host.contains("%"), host != "localhost", !host.hasSuffix(".localhost") else {
            return false
        }
        if let address = Self.ipv4(host) { return allowsIPv4(address, port: port) }
        if let bytes = Self.ipv6(host) { return allowsIPv6(bytes, port: port) }
        // Names ending in a number can be interpreted as legacy IPv4 by URL/DNS implementations.
        // Refuse invalid or ambiguous numeric spellings rather than passing them to DNS.
        let last = host.split(separator: ".", omittingEmptySubsequences: false).last ?? ""
        let numeric = !last.isEmpty && last.utf8.allSatisfy { (48 ... 57).contains($0) }
        return !host.split(separator: ".", omittingEmptySubsequences: false).contains("") &&
            !requiresIP && !numeric && !last.hasPrefix("0x") && !host.contains(":") &&
            host.utf8.allSatisfy { (97 ... 122).contains($0) || (48 ... 57).contains($0) || $0 == 45 || $0 == 46 }
    }

    private static func normalized(_ raw: String) -> String {
        var host = raw.lowercased()
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host.hasSuffix(".") { host.removeLast() }
        return host
    }

    /// Strict inet_aton number grammar: 1-4 parts, decimal/octal/hex, no signs, whitespace,
    /// empty parts, invalid digits or overflow. The final part fills the remaining octets.
    private static func ipv4(_ text: String) -> UInt32? {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard (1 ... 4).contains(parts.count) else { return nil }
        var value: UInt64 = 0
        for (index, part) in parts.enumerated() {
            guard !part.isEmpty else { return nil }
            var digits = part[...]
            var radix = 10
            if digits.hasPrefix("0x") {
                radix = 16
                digits = digits.dropFirst(2)
            } else if digits.count > 1, digits.first == "0" {
                radix = 8
                digits = digits.dropFirst()
            }
            guard !digits.isEmpty, digits.utf8.allSatisfy({ byte in
                (48 ... 57).contains(byte) || (radix == 16 && (97 ... 102).contains(byte))
            }), let number = UInt64(digits, radix: radix) else { return nil }
            let bits = index == parts.count - 1 ? 8 * (5 - parts.count) : 8
            guard number < (UInt64(1) << bits) else { return nil }
            value = (value << bits) | number
        }
        return UInt32(exactly: value)
    }

    private static func ipv6(_ text: String) -> [UInt8]? {
        var address = in6_addr()
        guard text.withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { return nil }
        return withUnsafeBytes(of: address) { Array($0) }
    }

    private func allowsIPv4(_ address: UInt32, port: Int) -> Bool {
        let first = address >> 24
        if first == 0 || first == 127 || address >> 16 == 0xA9FE ||
            (0x0A00_0201 ... 0x0A00_0206).contains(address) || address == 0x0A00_0302 { return false }
        let local = first == 10 || address >> 20 == 0xAC1 || address >> 16 == 0xC0A8 ||
            address >> 22 == 0x191
        return !local || !daemonPorts.contains(port)
    }

    private func allowsIPv6(_ bytes: [UInt8], port: Int) -> Bool {
        if bytes[0] == 0xFE, bytes[1] & 0xC0 == 0x80 || bytes[1] & 0xC0 == 0xC0 { return false }
        if Array(bytes.prefix(4)) == [0x20, 0x01, 0, 0] { return false }
        if bytes.allSatisfy({ $0 == 0 }) || (bytes.prefix(15).allSatisfy { $0 == 0 } && bytes[15] == 1) {
            return false
        }
        var embedded: [UInt8]?
        if bytes.prefix(12).allSatisfy({ $0 == 0 }) ||
            (bytes.prefix(10).allSatisfy { $0 == 0 } && bytes[10] == 0xFF && bytes[11] == 0xFF) ||
            (Array(bytes.prefix(12)) == [0, 0x64, 0xFF, 0x9B, 0, 0, 0, 0, 0, 0, 0, 0]) ||
            (Array(bytes.prefix(12)) == [0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0, 0])
        {
            embedded = Array(bytes[12 ..< 16])
        } else if Array(bytes.prefix(6)) == [0, 0x64, 0xFF, 0x9B, 0, 1] {
            // RFC 6052 layouts split IPv4 around the reserved octet at byte 8.
            // Recognize zero-suffix /48, /56 and /64 layouts, then /96 subprefixes.
            if bytes[6 ..< 12].allSatisfy({ $0 == 0 }) {
                embedded = Array(bytes[12 ..< 16])
            } else if bytes[8] == 0, bytes.suffix(5).allSatisfy({ $0 == 0 }) {
                embedded = [bytes[6], bytes[7], bytes[9], bytes[10]]
            } else if bytes[8] == 0, bytes.suffix(4).allSatisfy({ $0 == 0 }) {
                embedded = [bytes[7], bytes[9], bytes[10], bytes[11]]
            } else if bytes[8] == 0, bytes.suffix(3).allSatisfy({ $0 == 0 }) {
                embedded = Array(bytes[9 ..< 13])
            } else {
                embedded = Array(bytes[12 ..< 16])
            }
        } else if bytes[0] == 0x20, bytes[1] == 0x02 {
            embedded = Array(bytes[2 ..< 6])
        }
        if let embedded {
            let address = embedded.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            if !allowsIPv4(address, port: port) { return false }
        }
        return bytes[0] & 0xFE != 0xFC || !daemonPorts.contains(port)
    }
}
