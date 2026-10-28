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
        struct OS: OSVersionProvider { let majorVersion = 26 }
        let supported = Set(PrototypeAgentProtocol.advertisedCapabilities(os: OS()))
        // #13722: Intentional gaps in the iOS advertisement, each with its reason; remove them
        // when supported. The platform vocabulary (#14294) runs on the module registry (#14296),
        // and the `test` module is a placeholder no production runtime ever advertises.
        // motion v2 (#14208) is Android-only until the SwiftUI side lands (#14684), and so is
        // transition choreography (#15247). Android window and
        // modal motion (#15113) is Android-only (iOS is #14684). The haptics and sound platform
        // modules (#14329) are advertised through the platform registry the agent builds at launch,
        // not through the static list this test reads.
        // no renderer yet, and so do device media items (#14192).
        // Routes are contract-only until navigation and restore semantics ship.
        var exclusions: Set<String> = [
            "prototype_network_upload_v1", // Contract only until upload execution ships.
            // Realtime transport, routing and lifecycle remain owed by the runtime slices.
            "prototype_platform_realtime_v1", "prototype_platform_realtime_device_v1",
            "prototype_routes_v1",
            "prototype_platform_test_v1",
            "prototype_platform_share_v1", // Contract only; system share sheet runtime is owed.
            // Contract only; the device status readers are owed (#14323).
            "prototype_platform_battery_v1", "prototype_platform_power_v1",
            "prototype_platform_audio_v1",
            // Registered by the agent and Viewer registries (#14273), not the static list.
            "prototype_platform_connectivity_v1",
            // Contract only; the biometric prompt runtime is owed (#14328).
            "prototype_platform_biometric_v1",
            // Contract only; the settings launcher runtime is owed (#14320).
            "prototype_platform_settings_v1",
            // Registered by the agent and Viewer registries (#14238), not the static list.
            "prototype_platform_links_v1",
            // Contract only; the system picker runtimes are owed (#14318).
            "prototype_platform_contacts_v1", "prototype_platform_calendar_v1",
            // Contract only; the motion and sensor runtimes are owed (#14327).
            "prototype_platform_sensors_v1",
            // Contract only; the location runtimes are owed (#14325, #14326).
            "prototype_platform_location_v1",
            // Contract only; the system media picker and camera runtimes are owed (#14197).
            "prototype_platform_mediaLibrary_v1", "prototype_platform_camera_v1",
            // Contract only; the fake store runtime is owed (#14314).
            "prototype_platform_commerce_v1",
            // Contract only; the window controls runtime is owed (#14320).
            "prototype_platform_window_controls_v1",
            // Contract only; the keyboard dismiss runtime is owed (#14320).
            "prototype_hide_keyboard_v1",
            // Contract only; the fake identity provider runtime is owed (#14303).
            "prototype_platform_auth_v1",
            // Contract only; the Keychain-backed secure storage runtime is owed (#14321).
            "prototype_platform_secureStorage_v1",
            // Contract only; the voice-note recorder runtimes are owed (#14194).
            "prototype_platform_audioRecorder_v1",
            // #15131: custom AGSL shaders are Android-only by owner decision.
            "prototype_custom_shaders_v1",
            "prototype_motion_v2", "prototype_choreography_v1",
            "prototype_motion_v3", // Android only until #14684.
            "prototype_window_motion_v1",
            "prototype_platform_haptics_v1", "prototype_platform_sound_v1",
            "prototype_platform_media_items_v1",
        ]
        // Core tests also run on macOS 15/16, where the injected OS-version gate excludes iOS 17 keyframes.
        if !PrototypeAgentProtocol.advertisedCapabilities().contains("prototype_motion_tokens_v1") {
            exclusions.insert("prototype_motion_tokens_v1")
        }
        if !PrototypeAgentProtocol.advertisedCapabilities().contains("prototype_keyframes_v1") {
            exclusions.insert("prototype_keyframes_v1")
        }
        XCTAssertTrue(supported.contains("prototype_lazy_list_v1"))
        XCTAssertTrue(exclusions.isSubset(of: required), "Exclusions must name current spec gates")
        XCTAssertTrue(exclusions.isDisjoint(with: supported), "Remove exclusions once supported")
        XCTAssertEqual(required.subtracting(supported).subtracting(exclusions).sorted(), [])
    }

    func testSupportedCapabilitiesComeFromAgentAdvertisement() {
        let advertised = PrototypeAgentProtocol.advertisedCapabilities()
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
