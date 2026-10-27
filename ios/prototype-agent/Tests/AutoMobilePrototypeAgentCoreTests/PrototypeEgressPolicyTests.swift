@testable import AutoMobilePrototypeAgentCore
import XCTest
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// No test using this resolver performs system DNS, including mock public names.
final class FakeHostResolver: HostResolving, @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    let answers: [String]

    init(_ answers: [String] = ["8.8.8.8"]) { self.answers = answers }
    var requestedHosts: [String] { lock.withLock { names } }
    func addresses(for host: String) async throws -> [String] {
        lock.withLock { names.append(host) }
        return answers
    }
}

final class PrototypeEgressPolicyTests: XCTestCase {
    func testAdditionalPolicyRangesAndAllowedCounterparts() {
        let cases: [(String, PrototypeEgressPolicy.Decision)] = [
            ("::ffff:0:7f00:1", .block), ("::ffff:0:a9fe:a9fe", .block),
            ("::ffff:0:808:808", .allow), ("::ffff:0:a01:203", .allow),
            ("64:ff9b:1::7f00:1", .block), ("64:ff9b:1::a9fe:a9fe", .block),
            ("64:ff9b:1::808:808", .block), ("64:ff9b:1::c0a8:10a", .block),
            ("64:ff9b:1::800:0", .block), ("64:ff9b:1::a00:0", .block),
            ("64:ff9b:1:7f00:0:100::", .block), ("64:ff9b:1:a9fe:a9:fe00::", .block),
            ("64:ff9b:1:808:8:800::", .block), ("64:ff9b:1:a01:2:300::", .block),
            ("64:ff9b:1:7f:0:1::", .block), ("64:ff9b:1:8:8:808::", .block),
            ("64:ff9b:1:0:7f:0:100:0", .block), ("64:ff9b:1:0:8:808:800:0", .block),
            ("64:ff9b:2::7f00:1", .allow),
            ("fec0::1", .block), ("feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", .block),
            ("fe00::1", .allow), ("ff00::1", .block),
            ("2001::", .block), ("2001:0:ffff:ffff:ffff:ffff:ffff:ffff", .block),
            ("2000:ffff::1", .allow), ("2001:1::1", .allow), ("2001:4860::8888", .allow),
            ("10.0.2.1", .block), ("10.0.2.2", .block), ("10.0.2.3", .block),
            ("10.0.2.4", .block), ("10.0.2.5", .block), ("10.0.2.6", .block),
            ("10.0.2.0", .allow), ("10.0.2.7", .allow),
            ("10.0.3.2", .block), ("10.0.3.1", .allow), ("10.0.3.3", .allow),
            ("10.1.2.3", .allow), ("172.16.1.10", .allow), ("172.31.255.255", .allow),
            ("192.168.1.10", .allow),
            ("::ffff:0:a00:206", .block), ("64:ff9b:1::a00:302", .block),
        ]
        let policy = PrototypeEgressPolicy()
        for (host, expected) in cases {
            XCTAssertEqual(policy.check(host: host, port: 80, addresses: []), expected, host)
            XCTAssertEqual(policy.check(host: "public.example", port: 80, addresses: [host]), expected, host)
        }
        for host in ["::ffff:0:a01:203"] {
            XCTAssertEqual(policy.check(host: host, port: 3000, addresses: []), .block, host)
        }
    }

    func testBlockedDestinations() {
        let hosts = [
            "127.0.0.1", "127.1.2.3", "2130706433", "0x7f.1", "0177.0.0.1", "127.1", "127.0.1",
            "[::1]", "[::]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::127.0.0.1]", "[::7f00:1]",
            "[64:ff9b::7f00:1]", "[2002:7f00:1::]", "[fe80::1]", "febf::1",
            "169.254.169.254", "0.0.0.0", "0.1.2.3", "10.0.2.2", "10.0.2.3",
            "localhost", "LOCALHOST.", "foo.localhost", "FOO.LOCALHOST.",
            "::ffff:a00:202", "64:ff9b::a9fe:a9fe", "2002:a00:203::",
        ]
        for host in hosts {
            XCTAssertEqual(PrototypeEgressPolicy().check(host: host, port: 80, addresses: []), .block, host)
        }
    }

    func testAmbiguousNumericHostsAreRefused() {
        for host in [
            "0178.0.0.1",
            "0xgg.1",
            "4294967296",
            "1.2.3.256",
            "1..2",
            "1.2.3.4.5",
            "+127.1",
            "0x",
            "1.2.3.09",
        ] {
            XCTAssertEqual(PrototypeEgressPolicy().check(host: host, port: 80, addresses: []), .block, host)
        }
    }

    func testAllowedDestinationsAndLegacyPublicNumbers() {
        for host in [
            "8.8.8.8",
            "10.1.2.3",
            "192.168.1.10",
            "134744072",
            "0x8080808",
            "010.010.010.010",
            "8.526344",
            "8.8.2056",
            "2606:4700:4700::1111",
            "::ffff:808:808",
            "64:ff9b::808:808",
            "2002:808:808::",
        ] {
            XCTAssertEqual(PrototypeEgressPolicy().check(host: host, port: 80, addresses: []), .allow, host)
        }
    }

    func testCanonicalLiteralUsesPolicyLegacyIPv4AndHostNormalization() {
        let examples = [
            "134744072": "8.8.8.8",
            "0x8080808": "8.8.8.8",
            "010.010.010.010": "8.8.8.8",
            "8.526344": "8.8.8.8",
            "8.8.2056": "8.8.8.8",
            "[2606:4700::1]": "2606:4700::1",
            "8.8.8.8.": "8.8.8.8",
        ]
        for (raw, expected) in examples {
            XCTAssertEqual(PrototypeEgressPolicy.canonicalLiteral(raw), expected, raw)
        }
        for raw in ["example.test", "1.2.3.256", "[::1", "[2606:4700::1].", "8.8.8.8\0junk", "::1\0junk"] {
            XCTAssertNil(PrototypeEgressPolicy.canonicalLiteral(raw), raw)
        }
    }

    func testEmbeddedNulCannotBypassResolvedAddressCheck() {
        let policy = PrototypeEgressPolicy()
        XCTAssertEqual(policy.check(host: "public.example", port: 443, addresses: ["8.8.8.8", "::1\0junk"]), .block)
        XCTAssertEqual(policy.check(host: "::1\0junk", port: 443, addresses: []), .block)
    }

    func testAnyBlockedOrMalformedResolvedAddressRefusesTheName() {
        let policy = PrototypeEgressPolicy()
        XCTAssertEqual(policy.check(host: "public.example", port: 443, addresses: []), .block)
        for addresses in [["8.8.8.8", "127.0.0.1"], ["127.0.0.1", "8.8.8.8"], ["8.8.8.8", "not-an-ip"]] {
            XCTAssertEqual(policy.check(host: "public.example", port: 443, addresses: addresses), .block)
        }
        XCTAssertEqual(policy.check(host: "public.example", port: 443, addresses: ["8.8.8.8"]), .allow)
    }

    func testDaemonPortsOnLocalAddressesAndPublicAddresses() {
        let local = [
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "100.64.0.1",
            "100.127.255.255",
            "fc00::1",
            "fdff::1",
            "::ffff:192.168.1.1",
            "64:ff9b::c0a8:101",
            "2002:c0a8:101::",
        ]
        let policy = PrototypeEgressPolicy()
        for port in Array(3000 ... 3010) + [8765] {
            for host in local {
                XCTAssertEqual(policy.check(host: host, port: port, addresses: []), .block, "\(host):\(port)")
                XCTAssertEqual(policy.check(host: "public.example", port: port, addresses: [host]), .block)
            }
            XCTAssertEqual(policy.check(host: "8.8.8.8", port: port, addresses: []), .allow)
        }
        for host in local {
            XCTAssertEqual(policy.check(host: host, port: 8080, addresses: []), .allow, host)
        }
        for host in ["100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0"] {
            XCTAssertEqual(policy.check(host: host, port: 3000, addresses: []), .allow, host)
        }
        XCTAssertEqual(
            PrototypeEgressPolicy(daemonPorts: [1234]).check(host: "10.1.2.3", port: 1234, addresses: []),
            .block
        )
        XCTAssertEqual(
            PrototypeEgressPolicy(daemonPorts: []).check(host: "10.1.2.3", port: 3000, addresses: []),
            .allow
        )
        XCTAssertEqual(
            PrototypeEgressPolicy(daemonPorts: []).check(host: "127.0.0.1", port: 3000, addresses: []),
            .block
        )
    }

    func testMetricsConnectionCheckUsesTheSamePolicyAndDiscardsBody() async throws {
        let egress = PrototypeRequestEgressCheck(policy: PrototypeEgressPolicy(), resolver: FakeHostResolver())
        let url = try XCTUnwrap(URL(string: "https://public.example/"))
        XCTAssertFalse(egress.checkConnected(address: "127.0.0.1", url: url))
        XCTAssertFalse(egress.checkConnected(address: "10.1.2.3", url: url, port: 3000))
        XCTAssertTrue(egress.checkConnected(address: "8.8.8.8", url: url, port: 3000))
        let call = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 1000, request: URLRequest(url: url))
        XCTAssertTrue(call.accept(status: 200, headers: [:], expectedLength: 3))
        XCTAssertTrue(call.append(Data("abc".utf8)))
        do {
            let _: PrototypeHttpResponse = try await withCheckedThrowingContinuation { continuation in
                call.install(continuation)
                XCTAssertFalse(call.inspectConnection(address: "127.0.0.1", url: url, port: nil, egress: egress))
                call.finish(error: nil, measuredMs: 1)
            }
            XCTFail("Delivered a blocked response")
        } catch {
            XCTAssertEqual((error as? PrototypeHttpFailure)?.error.code, .blockedDestination)
        }
    }
}
