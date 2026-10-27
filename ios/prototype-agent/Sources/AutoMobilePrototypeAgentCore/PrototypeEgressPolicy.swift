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

    enum AddressClass: String, Equatable, Sendable {
        case blocked
        case `private`
        case `public`
    }

    private static let blockedV4: [ClosedRange<UInt32>] = [
        0x0000_0000 ... 0x00FF_FFFF, 0x7F00_0000 ... 0x7FFF_FFFF,
        0xA9FE_0000 ... 0xA9FE_FFFF, 0x0A00_0201 ... 0x0A00_0206,
        0x0A00_0302 ... 0x0A00_0302, 0xE000_0000 ... 0xFFFF_FFFF,
    ]
    private static let privateV4: [ClosedRange<UInt32>] = [
        0x0A00_0000 ... 0x0AFF_FFFF, 0xAC10_0000 ... 0xAC1F_FFFF,
        0xC0A8_0000 ... 0xC0A8_FFFF, 0x6440_0000 ... 0x647F_FFFF,
        0xC000_0000 ... 0xC000_00FF, 0xC000_0200 ... 0xC000_02FF,
        0xC633_6400 ... 0xC633_64FF, 0xCB00_7100 ... 0xCB00_71FF,
        0xC612_0000 ... 0xC613_FFFF,
    ]

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

    /// Produce a socket-safe literal after applying the same host normalization and
    /// legacy IPv4 parsing used by the policy. Names and malformed literals have no address.
    static func canonicalLiteral(_ raw: String) -> String? {
        let host = normalized(raw)
        if let address = ipv4(host) {
            return [24, 16, 8, 0].map { String((address >> $0) & 0xFF) }.joined(separator: ".")
        }
        return ipv6(host) == nil ? nil : host
    }

    private func checkHost(_ raw: String, port: Int, requiresIP: Bool) -> Bool {
        let host = Self.normalized(raw)
        guard !host.isEmpty, !host.contains("%"), host != "localhost", !host.hasSuffix(".localhost") else {
            return false
        }
        if let address = Self.ipv4(host) { return permits(Self.classifyV4(address), port: port) }
        if let bytes = Self.ipv6(host) { return permits(Self.classifyV6(bytes), port: port) }
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
        guard !text.utf8.contains(0) else { return nil }
        var address = in6_addr()
        guard text.withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { return nil }
        return withUnsafeBytes(of: address) { Array($0) }
    }

    static func classify(_ literal: String) -> AddressClass {
        guard !literal.utf8.contains(0) else { return .blocked }
        var address = in_addr()
        if literal.withCString({ inet_pton(AF_INET, $0, &address) }) == 1 {
            let bytes = withUnsafeBytes(of: address) { Array($0) }
            return classifyV4(v4Value(bytes))
        }
        guard !literal.contains("%"), let bytes = ipv6(literal) else { return .blocked }
        return classifyV6(bytes)
    }

    private func permits(_ kind: AddressClass, port: Int) -> Bool {
        kind == .public || (kind == .private && !daemonPorts.contains(port))
    }

    private static func v4Value(_ bytes: [UInt8]) -> UInt32 {
        bytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    }

    private static func classifyV4(_ address: UInt32) -> AddressClass {
        if blockedV4.contains(where: { $0.contains(address) }) { return .blocked }
        return privateV4.contains(where: { $0.contains(address) }) ? .private : .public
    }

    private static func classifyV6(_ bytes: [UInt8]) -> AddressClass {
        let words = stride(from: 0, to: 16, by: 2).map { UInt16(bytes[$0]) << 8 | UInt16(bytes[$0 + 1]) }
        if bytes.prefix(6).elementsEqual([0, 0x64, 0xFF, 0x9B, 0, 1]) {
            let layouts = [[6, 7, 9, 10], [7, 9, 10, 11], [9, 10, 11, 12], [12, 13, 14, 15]]
            let classes = layouts.map { classifyV4(v4Value($0.map { bytes[$0] })) }
            if classes.contains(.blocked) { return .blocked }
            return classes.contains(.private) ? .private : .public
        }
        let lowPrefixes: [[UInt16]] = [
            [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0xFFFF],
            [0, 0, 0, 0, 0xFFFF, 0], [0x64, 0xFF9B, 0, 0, 0, 0],
        ]
        let lowBits = lowPrefixes.contains { words.prefix(6).elementsEqual($0) }
        if words[0] == 0x2002 { return classifyV4(v4Value(Array(bytes[2 ..< 6]))) }
        if lowBits { return classifyV4(v4Value(Array(bytes[12 ..< 16]))) }
        if words[0] == 0x2001 && words[1] == 0 ||
            words[0] & 0xFFC0 == 0xFEC0 || words[0] & 0xFFC0 == 0xFE80 ||
            words[0] & 0xFF00 == 0xFF00 { return .blocked }
        if words[0] & 0xFE00 == 0xFC00 ||
            words[0] == 0x3FFF && words[1] & 0xF000 == 0 ||
            words.prefix(4).elementsEqual([0x100, 0, 0, 0]) ||
            words.prefix(3).elementsEqual([0x2001, 2, 0]) ||
            words.prefix(2).elementsEqual([0x2001, 0xDB8]) || words[0] == 0x5F00
        {
            return .private
        }
        return .public
    }
}
