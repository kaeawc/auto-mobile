@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Models UIKit: which schemes an installed app opens, and whether a view controller can present.
@MainActor
private final class FakeLinkOpener: PrototypeLinkOpener {
    var handledSchemes: Set<String> = ["http", "https", "maps", "sms"]
    var canPresent = true
    private(set) var external: [URL] = []
    private(set) var inApp: [URL] = []

    func openExternally(_ url: URL) async -> Bool {
        guard handledSchemes.contains(url.scheme ?? "") else { return false }
        external.append(url)
        return true
    }

    func presentInApp(_ url: URL) -> Bool {
        guard canPresent else { return false }
        inApp.append(url)
        return true
    }
}

@MainActor
final class PrototypeLinksRuntimeTests: XCTestCase {
    private func open(_ module: PrototypeLinksModule, _ url: String, mode: String? = nil) async
        -> PlatformCallResult
    {
        var args: [String: JSONValue] = ["url": .string(url)]
        if let mode { args["mode"] = .string(mode) }
        return await module.call(PlatformCall(callId: "c", call: "links.open", args: args))
    }

    private func result(_ outcome: String, _ url: String, _ mode: String) -> PlatformCallResult {
        .success(.object(["outcome": .string(outcome), "url": .string(url), "mode": .string(mode)]))
    }

    func testWebUrlsOpenInAppByDefaultAndInInAppMode() async {
        let opener = FakeLinkOpener()
        let module = PrototypeLinksModule(opener: opener)
        let auto = await open(module, "https://example.com")
        XCTAssertEqual(auto, result("opened", "https://example.com", "inApp"))
        let inApp = await open(module, "http://example.com", mode: "inApp")
        XCTAssertEqual(inApp, result("opened", "http://example.com", "inApp"))
        XCTAssertEqual(opener.inApp.count, 2)
        XCTAssertTrue(opener.external.isEmpty)
    }

    func testExternalModeAndNonWebSchemesOpenExternally() async {
        let opener = FakeLinkOpener()
        let module = PrototypeLinksModule(opener: opener)
        let web = await open(module, "https://example.com", mode: "external")
        XCTAssertEqual(web, result("opened", "https://example.com", "external"))
        let maps = await open(module, "maps://?q=coffee")
        XCTAssertEqual(maps, result("opened", "maps://?q=coffee", "external"))
        XCTAssertTrue(opener.inApp.isEmpty)
        XCTAssertEqual(opener.external.count, 2)
    }

    func testNoPresenterFallsBackToExternalAndReportsItOnlyForInApp() async {
        let opener = FakeLinkOpener()
        opener.canPresent = false
        let module = PrototypeLinksModule(opener: opener)
        let inApp = await open(module, "https://example.com", mode: "inApp")
        XCTAssertEqual(inApp, result("fallback", "https://example.com", "external"))
        let auto = await open(module, "https://example.com")
        XCTAssertEqual(auto, result("opened", "https://example.com", "external"))
    }

    func testAnUnhandledSchemeIsUnavailable() async {
        let module = PrototypeLinksModule(opener: FakeLinkOpener())
        let phone = await open(module, "tel:+15551234567")
        XCTAssertEqual(phone, .failure(.unavailable, "No installed app opens tel links"))
    }

    func testTheResultUrlIsCutAndBadArgumentsOpenNothing() async {
        let opener = FakeLinkOpener()
        let module = PrototypeLinksModule(opener: opener)
        let long = "https://example.com/" + String(repeating: "x", count: 3000)
        let cut = await open(module, long, mode: "external")
        XCTAssertEqual(cut, result("opened", String(long.prefix(2048)), "external"))
        let missing = await module.call(PlatformCall(callId: "c", call: "links.open", args: [:]))
        XCTAssertEqual(missing, .failure(.invalidArgs, "url is required"))
        let mode = await open(module, "https://example.com", mode: "popup")
        XCTAssertEqual(mode, .failure(.invalidArgs, "mode must be external, inApp or auto"))
        let unknown = await module.call(PlatformCall(callId: "c", call: "links.close", args: [:]))
        XCTAssertEqual(unknown, .failure(.unsupported, "Unknown call"))
        XCTAssertEqual(opener.external.count, 1)
    }
}
