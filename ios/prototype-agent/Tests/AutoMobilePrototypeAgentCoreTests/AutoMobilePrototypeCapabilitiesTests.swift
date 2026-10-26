@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class AutoMobilePrototypeCapabilitiesTests: XCTestCase {
    func testSharedSpecCapabilitiesAreSupported() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: repository.appendingPathComponent(
            "test/fixtures/prototype-capabilities/spec-capabilities.json"
        ))
        let required = try Set(JSONDecoder().decode([String].self, from: data))
        let supported = Set(AutoMobilePrototypeCapabilities.supported)
        // #13722: Intentional gaps in the iOS advertisement, each with its reason; remove them
        // when supported. The `test` module is a placeholder no production runtime advertises.
        // Chat-list scrolls (#14232) are drawn on Android only so far (#14671);
        // motion v2 (#14208) is Android-only until the SwiftUI side lands (#14684), and so is
        // transition choreography (#15247). Style effects (#15128) have a validated contract and
        // no renderer yet, and neither does any platform-namespace field (#15257).
        let exclusions: Set<String> = [
            "prototype_platform_test_v1", "prototype_platform_namespace_v1",
            "prototype_chat_scroll_v1", "prototype_motion_v2", "prototype_choreography_v1",
            "prototype_effects_v1",
        ]
        XCTAssertTrue(exclusions.isSubset(of: required), "Exclusions must name current spec gates")
        XCTAssertTrue(exclusions.isDisjoint(with: supported), "Remove exclusions once supported")
        XCTAssertEqual(required.subtracting(supported).subtracting(exclusions).sorted(), [])
    }

    func testSupportedCapabilitiesComeFromAgentAdvertisement() {
        let advertised = PrototypeAgentProtocol.capabilities
        XCTAssertTrue(Set(AutoMobilePrototypeCapabilities.supported).isSubset(of: Set(advertised)))
        XCTAssertEqual(
            AutoMobilePrototypeCapabilities.supported,
            advertised.filter { $0.hasPrefix("prototype_") }.sorted()
        )
    }

    func testCapabilityIsAdvertised() {
        XCTAssertTrue(PrototypeAgentProtocol.advertisedCapabilities().contains(PrototypeStylePolishV2.capability))
        XCTAssertTrue(AutoMobilePrototypeCapabilities.supported.contains(PrototypeStylePolishV2.capability))
    }
}
