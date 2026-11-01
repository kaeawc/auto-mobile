@testable import AutoMobilePrototypeAgentCore
import XCTest

private struct IsolationContract: Decodable {
    struct Module: Decodable {
        struct Call: Decodable {
            let permissions: [String]
            let capability: String?
        }

        let capability: String
        let calls: [String: Call]
    }

    let platformModules: [String: Module]
}

/// Pure unit test: production membership with inert services, no UIKit, daemon or device.
@MainActor
final class PrototypeAgentRuntimeIsolationTests: XCTestCase {
    private struct OS: OSVersionProvider { let majorVersion = Int.max }

    // Accept every plist requirement so filtering cannot hide a newly registered permissioned module.
    private struct BundleWithAllKeys: PrototypeBundleReader {
        func containsInfoPlistKey(_: String) -> Bool { true }
    }

    private final class Services: PrototypeHapticsPlayer, PrototypeSoundPlayer,
        PrototypeConnectivitySource, PrototypeLinkOpener
    {
        func perform(_: PrototypeHapticEffect) -> PrototypeFeedbackOutcome {
            XCTFail("Capability inspection must not play haptics")
            return .unavailable
        }

        func play(_: PrototypeSoundCue, volume _: Int?) -> PrototypeFeedbackOutcome {
            XCTFail("Capability inspection must not play sound")
            return .unavailable
        }

        func start(_: @escaping @MainActor @Sendable (PrototypeConnectivityReading) -> Void) {
            XCTFail("Capability inspection must not start connectivity monitoring")
        }

        func stop() {}
        func openExternally(_: URL) async -> Bool {
            XCTFail("Capability inspection must not open a URL")
            return false
        }

        func presentInApp(_: URL) -> Bool {
            XCTFail("Capability inspection must not present a browser")
            return false
        }
    }

    func testProductionRegistriesAndAdvertisementsExcludePermissionedModules() throws {
        let contract = try JSONDecoder().decode(IsolationContract.self, from: Data(prototypeSpecContractData.utf8))
        let permissioned = contract.platformModules.filter { _, module in
            module.calls.values.contains { !$0.permissions.isEmpty }
        }
        XCTAssertFalse(permissioned.isEmpty, "The contract must exercise the permission boundary")
        var forbidden = Set(permissioned.values.map(\.capability))
        for module in permissioned.values {
            forbidden.formUnion(module.calls.values.compactMap(\.capability))
        }

        let services = Services()
        let registries = [
            PrototypePlatformRegistry.feedbackModules(
                haptics: services, sound: services, connectivity: services, links: services,
                bundle: BundleWithAllKeys()
            ),
            PrototypePlatformRegistry.systemModules(
                clipboard: FakePrototypeClipboard(), connectivity: services, links: services,
                bundle: BundleWithAllKeys()
            ),
        ]
        for registry in registries {
            XCTAssertFalse(registry.modules.isEmpty)
            for name in registry.modules.keys {
                _ = try XCTUnwrap(contract.platformModules[name], "Unknown production module: \(name)")
                XCTAssertNil(permissioned[name], "Permissioned production module: \(name)")
            }
        }
        let advertised = PrototypeAgentProtocol.advertisedCapabilities(
            os: OS(), registryCapabilities: registries.flatMap(\.capabilities)
        )
        XCTAssertTrue(Set(advertised).isDisjoint(with: forbidden), "Permissioned capability advertised")
    }
}
