@testable import AutoMobileSDK
import Foundation
import XCTest

final class CarPlayTemplateDocumentTests: XCTestCase {
    @MainActor
    func testNotRegisteredAndUnregistered() throws {
        let registry = CarPlayTemplateRegistry()
        registry.unregister()
        let document = registry.snapshot()
        XCTAssertFalse(document.enabled)
        XCTAssertFalse(document.connected)
        XCTAssertTrue(document.templates.isEmpty)
        let data = try JSONEncoder().encode(document)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["presented"])
        XCTAssertNil(object["error"])
        XCTAssertEqual(object["schemaVersion"] as? Int, 1)
    }

    @MainActor
    func testRegistrationIsWeakAndUnregisterKeepsOptIn() throws {
        let registry = CarPlayTemplateRegistry()
        var source: FakeCarPlaySource? = FakeCarPlaySource()
        try registry.register(XCTUnwrap(source))
        XCTAssertTrue(registry.snapshot().connected)
        source = nil
        XCTAssertFalse(registry.snapshot().connected)
        XCTAssertTrue(registry.snapshot().enabled)
        let second = FakeCarPlaySource()
        registry.register(second)
        XCTAssertTrue(registry.snapshot().connected)
        registry.unregister()
        XCTAssertTrue(registry.snapshot().enabled)
        XCTAssertFalse(registry.snapshot().connected)
    }

    func testOnlyCarPlayGetBypassesPhoneForegroundGate() {
        XCTAssertFalse(SdkRouteTable.requiresApplicationActive(for: .matched(.carPlayTemplates)))
        for route in SdkRouteTable.Route.allCases where route != .carPlayTemplates {
            XCTAssertTrue(SdkRouteTable.requiresApplicationActive(for: .matched(route)))
        }
        XCTAssertTrue(SdkRouteTable.requiresApplicationActive(for: .notFound))
        XCTAssertTrue(SdkRouteTable.requiresApplicationActive(for: .malformed))
        XCTAssertTrue(SdkRouteTable.requiresApplicationActive(for: .methodNotAllowed(allowed: ["GET"])))
    }

    func testCarPlayRouteMethods() {
        XCTAssertEqual(
            SdkRouteTable.route(forRequestLine: "GET /carplay/templates HTTP/1.1"),
            .matched(.carPlayTemplates)
        )
        XCTAssertEqual(
            SdkRouteTable.route(forRequestLine: "POST /carplay/templates HTTP/1.1"),
            .methodNotAllowed(allowed: ["GET"])
        )
    }
}

#if canImport(CarPlay)
    import CarPlay
    import UIKit

    // iOS-only: run with xcodebuild on an iOS Simulator destination, never macOS swift test.
    @MainActor
    final class CarPlayTemplateMapperTests: XCTestCase {
        func testListGridTabsAndStablePaths() throws {
            let item = CPListItem(text: "North", detailText: "Available")
            let list = CPListTemplate(
                title: "Chargers",
                sections: [CPListSection(items: [item], header: "Nearby", sectionIndexTitle: nil)]
            )
            let grid = CPGridTemplate(
                title: "Actions",
                gridButtons: [CPGridButton(titleVariants: ["Start"], image: UIImage(), handler: nil)]
            )
            let tabs = CPTabBarTemplate(templates: [list, grid])
            var mapper = CarPlayTemplateMapper()
            let document = mapper.document(templates: [tabs, list])
            let children = try XCTUnwrap(document.templates.first?.tabs)
            XCTAssertEqual(children.count, 2)
            let row = try XCTUnwrap(children.first?.template?.sections?.first?.items?.first)
            XCTAssertEqual(row.id, "stack/0/tabs/0/template/sections/0/items/0")
            XCTAssertEqual(row.text, "North")
            XCTAssertEqual(row.detailText, "Available")
            XCTAssertEqual(row.hasImage, false)
            XCTAssertEqual(children[1].template?.buttons?.first?.titleVariants, ["Start"])
            XCTAssertEqual(document.templates[1].id, "stack/1")
            XCTAssertFalse(document.truncated)
            let encoded = try JSONEncoder().encode(document)
            let decoded = try JSONDecoder().decode(CarPlayTemplateDocument.self, from: encoded)
            XCTAssertEqual(decoded.templates.first?.tabs?.first?.template?.sections?.first?.items?.first?.text, "North")
        }

        func testInformationAlertSheetAndUnknown() {
            let info = CPInformationTemplate(
                title: "Info",
                layout: .leading,
                items: [CPInformationItem(title: "Port", detail: "Ready")],
                actions: []
            )
            let alert = CPAlertTemplate(titleVariants: ["Notice"], actions: [])
            let sheet = CPActionSheetTemplate(
                title: "Choose",
                message: "Action",
                actions: [CPAlertAction(title: "Done", style: .default, handler: { _ in })]
            )
            var mapper = CarPlayTemplateMapper()
            let document = mapper.document(templates: [info, sheet, CPTemplate()], presented: alert)
            XCTAssertEqual(document.templates[0].items?.first?.detail, "Ready")
            XCTAssertEqual(document.templates[1].actions?.first?.title, "Done")
            XCTAssertEqual(document.templates[2].type, "unknown")
            XCTAssertNotNil(document.templates[2].className)
            XCTAssertEqual(document.presented?.id, "presented")
            XCTAssertEqual(document.presented?.titleVariants, ["Notice"])
        }

        func testBudgetsIncludeSectionsRowsAndDepth() {
            let list = CPListTemplate(title: "List", sections: (0 ..< 3).map { _ in
                CPListSection(items: (0 ..< 3).map { CPListItem(text: "Item \($0)", detailText: nil) })
            })
            var items = CarPlayTemplateMapper(maxItems: 1)
            let cappedItems = items.document(templates: [list])
            XCTAssertTrue(cappedItems.truncated)
            XCTAssertEqual(cappedItems.templates.first?.sections?.count, 1)
            XCTAssertEqual(cappedItems.templates.first?.sections?.first?.items?.count, 1)
            var nodes = CarPlayTemplateMapper(maxNodes: 2)
            let cappedNodes = nodes.document(templates: [list])
            XCTAssertTrue(cappedNodes.truncated)
            XCTAssertEqual(cappedNodes.templates.first?.sections?.first?.items?.count, 0)
            var depth = CarPlayTemplateMapper(maxDepth: 0)
            XCTAssertTrue(depth.document(templates: [list]).truncated)
        }
    }
#endif

@MainActor
private final class FakeCarPlaySource: CarPlayTemplateSource {
    func carPlaySnapshot() -> CarPlayTemplateDocument {
        CarPlayTemplateDocument(enabled: true, connected: true)
    }
}
