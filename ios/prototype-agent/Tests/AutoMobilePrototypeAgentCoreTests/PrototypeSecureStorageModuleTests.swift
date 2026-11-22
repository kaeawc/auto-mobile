@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
final class PrototypeSecureStorageModuleTests: XCTestCase {
    func testModuleStateAndUnsupportedCalls() async {
        let module = PrototypeSecureStorageModule(store: FakeSecureValueStore())
        XCTAssertEqual(module.name, "secureStorage")
        XCTAssertEqual(module.capability, "prototype_platform_secureStorage_v1")
        XCTAssertEqual(module.availability(), .ready)
        XCTAssertEqual(module.state, ["locked": .bool(false)])
        module.restored(locked: ["state:token"])
        XCTAssertEqual(module.state, ["locked": .bool(true)])
        module.stop()
        module.restored(locked: [])
        XCTAssertEqual(module.state, ["locked": .bool(false)])
        let result = await module.call(.init(callId: "test", call: "secureStorage.read", args: [:]))
        XCTAssertEqual(result, .failure(.unsupported, "Secure storage has no platform calls"))
    }

    func testRegistryMembershipUsesTheSuppliedStoreOnly() {
        let source = Services()
        let store = FakeSecureValueStore()
        let defaults = PrototypePlatformRegistry.feedbackModules(
            haptics: source, sound: source, connectivity: source, links: source, settings: source
        )
        XCTAssertNil(defaults.secureStorage)
        XCTAssertFalse(defaults.capabilities.contains("prototype_platform_secureStorage_v1"))
        let standalone = PrototypePlatformRegistry.feedbackModules(
            haptics: source, sound: source, connectivity: source, links: source, settings: source, secureStorage: store
        )
        let viewer = PrototypePlatformRegistry.systemModules(
            clipboard: source, connectivity: source, links: source, settings: source, secureStorage: store
        )
        for registry in [standalone, viewer] {
            XCTAssertTrue(registry.secureStorage as? FakeSecureValueStore === store)
            XCTAssertTrue(registry.capabilities.contains("prototype_platform_secureStorage_v1"))
            let embedded = registry.withoutSecureStorage
            XCTAssertTrue(embedded === registry.withoutSecureStorage)
            XCTAssertNil(registry.withoutSecureStorage.secureStorage)
            XCTAssertFalse(registry.withoutSecureStorage.capabilities.contains("prototype_platform_secureStorage_v1"))
        }
    }

    private final class Services: PrototypeHapticsPlayer, PrototypeSoundPlayer,
        PrototypeConnectivitySource, PrototypeLinkOpener, PrototypeSettingsURLOpener, PrototypeClipboard
    {
        func perform(_: PrototypeHapticEffect) -> PrototypeFeedbackOutcome { .unavailable }
        func play(_: PrototypeSoundCue, volume _: Int?) -> PrototypeFeedbackOutcome { .unavailable }
        func start(_: @escaping @MainActor @Sendable (PrototypeConnectivityReading) -> Void) {}
        func stop() {}
        var appSettingsURL: URL? { nil }
        var notificationSettingsURL: URL? { nil }
        func open(_: URL) async -> Bool { false }
        func openExternally(_: URL) async -> Bool { false }
        func presentInApp(_: URL) -> Bool { false }
        func copy(text _: String, sensitive _: Bool, label _: String?) {}
        var hasText: Bool { false }
        func paste() async throws -> String { "" }
    }
}
