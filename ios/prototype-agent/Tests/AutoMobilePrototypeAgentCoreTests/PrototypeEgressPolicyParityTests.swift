@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeEgressPolicyParityTests: XCTestCase {
    private struct AddressFixture: Decodable {
        let daemonPorts: [Int]
        let ordinaryPort: Int
        let classes: [String: [String]]
    }

    private var fixture: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-egress-policy/addresses.json")
    }

    func testSharedAddressClassificationAndPorts() throws {
        let shared = try JSONDecoder().decode(AddressFixture.self, from: Data(contentsOf: fixture))
        XCTAssertEqual(shared.classes.values.reduce(0) { $0 + $1.count }, 230)
        XCTAssertEqual(shared.daemonPorts, [3000, 4567, 8765])
        let policy = PrototypeEgressPolicy(daemonPorts: Set(shared.daemonPorts))
        for (kind, addresses) in shared.classes {
            for address in addresses {
                XCTAssertEqual(PrototypeEgressPolicy.classify(address).rawValue, kind, address)
                let ordinary: PrototypeEgressPolicy.Decision = kind == "blocked" ? .block : .allow
                let daemon: PrototypeEgressPolicy.Decision = kind == "public" ? .allow : .block
                XCTAssertEqual(policy.check(host: address, port: shared.ordinaryPort, addresses: []), ordinary, address)
                XCTAssertEqual(
                    policy.check(host: "public.example", port: shared.ordinaryPort, addresses: [address]),
                    ordinary,
                    address
                )
                for port in shared.daemonPorts {
                    XCTAssertEqual(policy.check(host: address, port: port, addresses: []), daemon, address)
                    XCTAssertEqual(
                        policy.check(host: "public.example", port: port, addresses: [address]),
                        daemon,
                        address
                    )
                }
            }
        }
    }

    func testClassifyRequiresStrictIPLiteral() {
        for address in ["127.1", "0x7f.1", "2130706433", "[::1]", "fe80::1%en0", "not-an-ip", "8.8.8.8\0junk"] {
            XCTAssertEqual(PrototypeEgressPolicy.classify(address), .blocked, address)
        }
    }
}
