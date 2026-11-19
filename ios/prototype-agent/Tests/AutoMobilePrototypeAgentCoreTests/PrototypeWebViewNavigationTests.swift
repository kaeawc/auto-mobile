@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeWebViewNavigationTests: XCTestCase {
    @MainActor
    func testBlockedInitialLoadAndSubframe() async throws {
        let page = FakeWebPage()
        let probe = try NavigationProbe(page: page)
        await probe.navigation.prepare { _ in }
        probe.navigation.load("https://other.com")
        XCTAssertTrue(page.loads.isEmpty)
        XCTAssertEqual(probe.status, "blocked")
        XCTAssertEqual(probe.lastActionURL, "page https://other.com")

        XCTAssertFalse(probe.navigation.permits("http://example.com", mainFrame: false))
        XCTAssertEqual(probe.updates.count, 1)
    }

    @MainActor
    func testRedirectsAreCheckedAndCancellationPreservesBlockedState() async throws {
        for target in ["https://other.com/redirect", "http://example.com/downgrade"] {
            let page = FakeWebPage()
            let probe = try NavigationProbe(page: page)
            await probe.navigation.prepare { _ in }
            probe.navigation.load("https://example.com/")
            XCTAssertEqual(page.loads.map(\.absoluteString), ["https://example.com/"])
            XCTAssertEqual(probe.status, "loading")
            XCTAssertFalse(probe.navigation.permits(target, mainFrame: true))
            probe.navigation.failed(url: target)
            probe.navigation.finished("https://example.com/")
            XCTAssertEqual(probe.updates.count, 2)
            XCTAssertEqual(probe.status, "blocked")
            XCTAssertEqual(probe.lastActionURL, "page \(target)")
        }
    }

    @MainActor
    func testAllowedFinishPublishesStateAndAction() async throws {
        let page = FakeWebPage()
        let probe = try NavigationProbe(page: page)
        await probe.navigation.prepare { _ in }
        probe.navigation.load("https://example.com/")
        page.title = "Article"
        page.canGoBack = true
        probe.navigation.finished("https://example.com/article")
        XCTAssertEqual(probe.status, "loaded")
        XCTAssertEqual(probe.updates.last?.writes.first(where: { $0.0 == "title" })?.1, .string("Article"))
        XCTAssertEqual(probe.updates.last?.writes.first(where: { $0.0 == "back" })?.1, .bool(true))
        XCTAssertEqual(probe.lastActionURL, "page https://example.com/article")
    }

    @MainActor
    func testRuleCompilationFailureCannotLoad() async throws {
        enum CompilationError: Error { case badRules }
        let page = FakeWebPage()
        let probe = try NavigationProbe(page: page)
        await probe.navigation.prepare { _ in throw CompilationError.badRules }
        probe.navigation.load("https://example.com/")
        XCTAssertTrue(page.loads.isEmpty)
        XCTAssertEqual(probe.status, "error")
    }

    @MainActor
    func testPlatformCallsRouteOnlyToAttachedNodeInTheirPresentation() async {
        let root = PrototypePlatformRegistry(modules: [PrototypeWebViewModule()])
        let first = root.forPresentation()
        let second = root.forPresentation()
        guard let module = first.modules["webview"] as? PrototypeWebViewModule,
              let other = second.modules["webview"] as? PrototypeWebViewModule
        else { return XCTFail("Missing presentation modules") }
        let page = FakeWebPage()
        page.canGoBack = true
        module.attach("page", page: page)
        let back = PlatformCall(callId: "1", call: "webview.back", args: ["node": .string("page")])
        let reload = PlatformCall(callId: "2", call: "webview.reload", args: ["node": .string("page")])
        let missing = await other.call(reload)
        let backResult = await module.call(back)
        let reloadResult = await module.call(reload)
        XCTAssertEqual(missing, .failure(.unavailable, "Web view is not attached"))
        XCTAssertEqual(backResult, .success(.null))
        XCTAssertEqual(reloadResult, .success(.null))
        XCTAssertEqual(page.backCalls, 1)
        XCTAssertEqual(page.reloadCalls, 1)
        module.detach("page", page: page)
        let detached = await module.call(reload)
        XCTAssertEqual(detached, missing)
    }

    func testRendererDoesNotInstallAScriptBridge() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/AutoMobilePrototypeAgent")
        let webSources = try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("PrototypeWebView") && $0.pathExtension == "swift" }
        XCTAssertFalse(webSources.isEmpty)
        for source in webSources + [sources.appendingPathComponent("PrototypeRenderer.swift")] {
            let code = try String(contentsOf: source, encoding: .utf8)
            for token in [
                "evaluateJavaScript", "WKUserScript", "addUserScript", "add(_:name:)", "WKScriptMessageHandler",
            ] {
                XCTAssertFalse(code.contains(token), "\(source.lastPathComponent): \(token)")
            }
            XCTAssertNil(code.range(of: #"\.add\s*\([^)]*,\s*name\s*:"#, options: .regularExpression))
        }
    }
}

@MainActor
private final class FakeWebPage: PrototypeWebPage {
    var canGoBack = false
    var title: String?
    var loads: [URL] = []
    var backCalls = 0
    var reloadCalls = 0

    func loadPage(_ url: URL) { loads.append(url) }
    func backPage() { backCalls += 1 }
    func reloadPage() { reloadCalls += 1 }
}

@MainActor
private final class NavigationProbe {
    let node: PrototypeNode
    let page: FakeWebPage
    private(set) var updates: [PrototypeWebViewNavigation.Update] = []
    lazy var navigation = PrototypeWebViewNavigation(node: node, page: page) { [weak self] update in
        self?.updates.append(update)
    }

    var status: String? { updates.last?.writes.first(where: { $0.0 == "status" })?.1.stringValue }
    var lastActionURL: String? { updates.last?.actions.first?.payload?.stringValue }

    init(page: FakeWebPage) throws {
        self.page = page
        node = try JSONDecoder().decode(PrototypeNode.self, from: Data("""
        {
          "type": "webView", "url": "https://example.com/", "allowedOrigins": ["https://example.com"],
          "navigationStateKey": "status", "titleKey": "title", "canGoBackKey": "back",
          "onBlockedNavigation": [{"type": "emit", "name": "blocked", "payload": "page {url}"}],
          "onNavigate": [{"type": "emit", "name": "loaded", "payload": "page {url}"}]
        }
        """.utf8))
    }
}
