@testable import AutoMobileSDK
import Foundation
import XCTest

/// Both packages read the SAME host fixture, not copies in separate resource bundles.
final class SdkSimulatorPortTests: XCTestCase {
    private struct Fixture: Decodable {
        let udid: String
        let ports: [UInt16]
    }

    func testSharedContractFixture() throws {
        let iosDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixtures = try JSONDecoder().decode(
            [Fixture].self, from: Data(contentsOf: iosDirectory.appendingPathComponent("sdk-port-contract.json"))
        )
        XCTAssertGreaterThanOrEqual(fixtures.count, 20)
        for fixture in fixtures {
            XCTAssertEqual(fixture.ports.count, SdkSimulatorPort.probeCount)
            for (attempt, port) in fixture.ports.enumerated() {
                XCTAssertEqual(SdkSimulatorPort.simulatorPort(udid: fixture.udid, attempt: attempt), port, fixture.udid)
            }
        }
    }

    func testRangeDeterminismCaseAndDistinctProbes() {
        for index in 0 ..< 256 {
            let udid = String(format: "abcdef00-1234-4567-89ab-%012x", index)
            let ports = (0 ..< SdkSimulatorPort.probeCount).map {
                SdkSimulatorPort.simulatorPort(udid: udid, attempt: $0)
            }
            XCTAssertEqual(Set(ports).count, SdkSimulatorPort.probeCount)
            for (attempt, port) in ports.enumerated() {
                XCTAssertTrue((40000 ... 40999).contains(port))
                XCTAssertEqual(port, SdkSimulatorPort.simulatorPort(udid: udid, attempt: attempt))
                XCTAssertEqual(port, SdkSimulatorPort.simulatorPort(udid: udid.uppercased(), attempt: attempt))
            }
        }
    }

    func testProbingWrapsWithinReservedRange() {
        let udid = "00000000-0000-0000-0000-0000000008e9"
        XCTAssertEqual(SdkSimulatorPort.simulatorPort(udid: udid), 40999)
        XCTAssertEqual(SdkSimulatorPort.simulatorPort(udid: udid, attempt: 1), 40000)
        XCTAssertEqual(SdkSimulatorPort.simulatorPort(udid: udid, attempt: 7), 40006)
    }
}
