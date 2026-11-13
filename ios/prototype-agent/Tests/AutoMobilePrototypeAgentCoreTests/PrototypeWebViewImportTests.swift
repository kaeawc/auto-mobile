import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeWebViewImportTests: XCTestCase {
    private func fixture(_ name: String = "valid/webview-node.json") throws -> Data {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: root.appendingPathComponent("test/fixtures/prototype-spec/\(name)"))
    }

    private struct ImportCase: Decodable {
        let name: String
        let spec: JSONValue
        let path: String?
    }

    func testSharedCasesPinFirstReportedPathIndependentOfKeyOrder() throws {
        let cases = try JSONDecoder().decode([ImportCase].self, from: fixture("webview-import/cases.json"))
        XCTAssertFalse(cases.isEmpty)
        for item in cases {
            XCTAssertEqual(PrototypeWebView.importError(item.spec, networkAllowed: false)?.path, item.path, item.name)
            let data = try JSONEncoder().encode(item.spec)
            XCTAssertEqual(PrototypeWebView.importError(data, networkAllowed: false)?.path, item.path, item.name)
        }
    }

    func testMalformedSavedDataReturnsNilAsInKotlin() {
        XCTAssertNil(PrototypeWebView.importError(Data("{not json".utf8), networkAllowed: false))
        XCTAssertNil(PrototypeWebView.importError(Data("[]".utf8), networkAllowed: false))
    }

    func testNetworkSwitchRefusesFirstPageAndAllowsSameFixtureWhenEnabled() throws {
        let data = try fixture()
        let spec = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(PrototypeWebView.importError(spec, networkAllowed: false)?.path, "root.children[1]")
        XCTAssertEqual(
            PrototypeWebView.importError(data, networkAllowed: false),
            PrototypeWebView.importError(spec, networkAllowed: false)
        )
        XCTAssertNil(PrototypeWebView.importError(data, networkAllowed: true))
        XCTAssertNil(PrototypeWebView.importError(spec, networkAllowed: true))
    }

    @MainActor
    func testDecisionTracksLiveNetworkSwitch() throws {
        let setting = PrototypeLibraryNetworkSwitch(store: WebViewNetworkSettingStore())
        let data = try fixture()
        XCTAssertNotNil(PrototypeWebView.importError(data, networkAllowed: setting.enabled))
        setting.enabled = true
        XCTAssertNil(PrototypeWebView.importError(data, networkAllowed: setting.enabled))
        setting.enabled = false
        XCTAssertNotNil(PrototypeWebView.importError(data, networkAllowed: setting.enabled))
    }

    func testOpaqueDataAndActionPayloadsAreNotNodes() throws {
        let data =
            Data(
                #"{"data":{"type":"webView"},"root":{"type":"button","onTap":[{"type":"emit","payload":{"type":"webView"}}]}}"#
                    .utf8
            )
        XCTAssertNil(PrototypeWebView.importError(data, networkAllowed: false))
    }

    func testNestedRepeatTemplateIsCheckedEvenWithNoItemsAndFirstPageWins() {
        let data =
            Data(
                #"{"root":{"type":"column","repeat":{"items":[],"as":"item"},"children":[{"type":"box","child":{"type":"webView"}},{"type":"webView"}]}}"#
                    .utf8
            )
        XCTAssertEqual(PrototypeWebView.importError(data, networkAllowed: false)?.path, "root.children[0].child")
    }
}

@MainActor
private final class WebViewNetworkSettingStore: PrototypeLibraryNetworkSettingStore {
    private var enabled = false
    func bool(forKey _: String) -> Bool { enabled }
    func set(_ value: Bool, forKey _: String) { enabled = value }
}
