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
        // Intentional gaps, each with its reason; remove them when supported.
        // #14689: shimmer (#14207) is drawn on Android only until the SwiftUI side lands.
        let exclusions: Set<String> = ["prototype_loading_states_v1"]
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
}
