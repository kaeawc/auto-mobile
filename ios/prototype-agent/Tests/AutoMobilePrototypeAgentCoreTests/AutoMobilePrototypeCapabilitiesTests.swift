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
        // when supported. The platform vocabulary (#14294) runs on the module registry (#14296),
        // and the `test` module is a placeholder no production runtime ever advertises.
        // motion v2 (#14208) is Android-only until the SwiftUI side lands (#14684), and so is
        // transition choreography (#15247), and neither does any platform-namespace field (#15257). Android window and
        // modal motion (#15113) is Android-only (iOS is #14684). The haptics and sound platform
        // modules (#14329) are advertised through the platform registry the agent builds at launch,
        // not through the static list this test reads.
        // no renderer yet, and so do device media items (#14192).
        // Routes are contract-only until navigation and restore semantics ship.
        let exclusions: Set<String> = [
            "prototype_routes_v1",
            "prototype_platform_test_v1", "prototype_platform_namespace_v1",
            // #15131: custom AGSL shaders are Android-only by owner decision.
            "prototype_custom_shaders_v1",
            "prototype_motion_v2", "prototype_choreography_v1",
            "prototype_motion_v3", // Android only until #14684.
            "prototype_window_motion_v1",
            "prototype_platform_haptics_v1", "prototype_platform_sound_v1",
            "prototype_platform_media_items_v1",
        ]
        XCTAssertTrue(supported.contains("prototype_lazy_list_v1"))
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

    func testEffectsCapabilityIsAdvertised() {
        XCTAssertTrue(PrototypeAgentProtocol.advertisedCapabilities().contains(PrototypeEffects.capability))
        XCTAssertTrue(AutoMobilePrototypeCapabilities.supported.contains("prototype_effects_v1"))
    }

    func testCapabilityIsAdvertised() {
        XCTAssertTrue(PrototypeAgentProtocol.advertisedCapabilities().contains(PrototypeStylePolishV2.capability))
        XCTAssertTrue(AutoMobilePrototypeCapabilities.supported.contains(PrototypeStylePolishV2.capability))
    }
}
