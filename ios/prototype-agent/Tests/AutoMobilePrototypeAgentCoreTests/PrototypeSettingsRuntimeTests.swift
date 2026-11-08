@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

@MainActor
final class PrototypeSettingsRuntimeTests: XCTestCase {
    private final class Opener: PrototypeSettingsURLOpener {
        var appSettingsURL = URL(string: "fake-settings:app")
        var notificationSettingsURL = URL(string: "fake-settings:notifications")
        var succeeds = true
        var opened: [URL] = []
        func open(_ url: URL) async -> Bool {
            opened.append(url)
            return succeeds
        }
    }

    private func open(_ module: PrototypeSettingsModule, page: String) async -> PlatformCallResult {
        await module.call(PlatformCall(callId: "settings", call: "settings.open", args: ["page": .string(page)]))
    }

    func testAppAndNotificationsMapToTheirOwnSettingsURLs() async throws {
        let opener = Opener()
        let module = PrototypeSettingsModule(opener: opener)
        XCTAssertEqual(module.capability, "prototype_platform_settings_v1")
        for page in ["app", "notifications"] {
            let result = await open(module, page: page)
            XCTAssertEqual(result, .success(.object(["outcome": .string("opened"), "page": .string(page)])))
        }
        XCTAssertEqual(opener.opened, try [XCTUnwrap(opener.appSettingsURL), XCTUnwrap(opener.notificationSettingsURL)])
    }

    func testOtherPagesAreUnavailableAndNeverOpenAURL() async {
        let opener = Opener()
        let module = PrototypeSettingsModule(opener: opener)
        for page in ["location", "wifi", "bluetooth", "display", "unknown", ""] {
            let result = await open(module, page: page)
            XCTAssertEqual(result, .failure(.unavailable, "Settings page is unavailable on iOS: \(page)"))
        }
        XCTAssertTrue(opener.opened.isEmpty)
    }

    func testMissingURLAndRejectedOpenAreUnavailable() async {
        let opener = Opener()
        let module = PrototypeSettingsModule(opener: opener)
        opener.appSettingsURL = nil
        let missing = await open(module, page: "app")
        XCTAssertEqual(missing, .failure(.unavailable, "Unable to open settings page: app"))
        XCTAssertTrue(opener.opened.isEmpty)
        opener.succeeds = false
        let rejected = await open(module, page: "notifications")
        XCTAssertEqual(rejected, .failure(.unavailable, "Unable to open settings page: notifications"))
        XCTAssertEqual(opener.opened.count, 1)
    }

    func testInvalidArgumentsAndUnknownCallsNeverOpenAURL() async {
        let opener = Opener()
        let module = PrototypeSettingsModule(opener: opener)
        let missing = await module.call(PlatformCall(callId: "a", call: "settings.open", args: [:]))
        XCTAssertEqual(missing, .failure(.invalidArgs, "page is required"))
        let unknown = await module.call(PlatformCall(callId: "b", call: "settings.other", args: [:]))
        XCTAssertEqual(unknown, .failure(.unsupported, "Unknown call"))
        XCTAssertTrue(opener.opened.isEmpty)
    }
}
