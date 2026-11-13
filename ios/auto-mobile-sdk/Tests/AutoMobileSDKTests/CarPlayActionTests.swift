@testable import AutoMobileSDK
import Foundation
import XCTest

final class CarPlayActionContractTests: XCTestCase {
    func testRequestDecodingAndValidation() throws {
        let decoder = JSONDecoder()
        XCTAssertEqual(
            try decoder.decode(CarPlayActionRequest.self, from: Data(#"{"id":"stack/0"}"#.utf8)).action,
            .select
        )
        for action in ["back", "popToRoot"] {
            let data = try JSONSerialization.data(withJSONObject: ["action": action])
            XCTAssertTrue(try decoder.decode(CarPlayActionRequest.self, from: data).isValid)
        }
        XCTAssertFalse(try decoder.decode(CarPlayActionRequest.self, from: Data("{}".utf8)).isValid)
        XCTAssertFalse(CarPlayActionRequest(id: " \n").isValid)
        for body in [#"{"action":"tap"}"#, #"{"action":null}"#, #"{"id":null}"#] {
            XCTAssertThrowsError(try decoder.decode(CarPlayActionRequest.self, from: Data(body.utf8)))
        }
    }

    @MainActor
    func testUnsupportedAndPostActionEnvelope() throws {
        let registry = CarPlayTemplateRegistry()
        var result: CarPlayActionResponse?
        registry.perform(CarPlayActionRequest(id: "stack/0")) { result = $0 }
        let response = try XCTUnwrap(result)
        XCTAssertEqual(response.status, .unsupported)
        XCTAssertTrue(response.reason?.contains("registerCarPlay") == true)
        XCTAssertEqual(response.simulated, "sdk")
        XCTAssertFalse(response.templates.enabled)
        let encoded = try XCTUnwrap(
            JSONSerialization
                .jsonObject(with: JSONEncoder().encode(response)) as? [String: Any]
        )
        XCTAssertEqual(encoded["simulated"] as? String, "sdk")
        XCTAssertEqual(encoded["schemaVersion"] as? Int, 1)
        XCTAssertEqual(encoded["action"] as? String, "select")
        XCTAssertNotNil(encoded["templates"])

        let source = FakeCarPlayActionSource()
        registry.register(source)
        registry.perform(CarPlayActionRequest(action: .back)) { result = $0 }
        XCTAssertNil(result?.id)
        XCTAssertEqual(result?.status, .success)
        XCTAssertEqual(result?.templates.templates.first?.title, "after pop")
        XCTAssertEqual(result?.simulated, "sdk")
        registry.unregister()
        registry.perform(CarPlayActionRequest(action: .popToRoot)) { result = $0 }
        XCTAssertEqual(result?.status, .unsupported)
        XCTAssertTrue(result?.reason?.contains("connected") == true)
        XCTAssertTrue(result?.templates.enabled == true)
        XCTAssertFalse(result?.templates.connected == true)
    }

    @MainActor
    func testSnapshotWaitsForPopCompletionAndReportsFailure() throws {
        let source = FakeCarPlayActionSource()
        source.deferCompletion = true
        let registry = CarPlayTemplateRegistry()
        registry.register(source)
        var response: CarPlayActionResponse?
        registry.perform(CarPlayActionRequest(action: .back)) { response = $0 }
        XCTAssertNil(response)
        source.pending?(CarPlayActionOutcome(status: .failed, reason: "fake pop failed"))
        XCTAssertEqual(response?.status, .failed)
        XCTAssertEqual(response?.reason, "fake pop failed")
        XCTAssertEqual(response?.templates.templates.first?.title, "after pop")
        XCTAssertEqual(response?.simulated, "sdk")
    }
}

@MainActor
private final class FakeCarPlayActionSource: CarPlayActionSource {
    var popped = false
    var deferCompletion = false
    var pending: (@MainActor (CarPlayActionOutcome) -> Void)?

    func carPlaySnapshot() -> CarPlayTemplateDocument {
        let node = CarPlayTemplateNode(id: "stack/0", type: "list")
        node.title = popped ? "after pop" : "before pop"
        return CarPlayTemplateDocument(enabled: true, connected: true, templates: [node])
    }

    func carPlaySelect(id _: String) -> CarPlayActionOutcome { CarPlayActionOutcome(status: .notFound) }

    func carPlayPop(toRoot _: Bool, completion: @escaping @MainActor (CarPlayActionOutcome) -> Void) {
        popped = true
        if deferCompletion { pending = completion }
        else { completion(CarPlayActionOutcome(status: .success)) }
    }
}

#if canImport(CarPlay)
    import CarPlay
    import UIKit

    @MainActor
    final class CarPlayActionPerformerTests: XCTestCase {
        func testSelectListItemInvokesOnceAndSnapshotReflectsHandler() throws {
            let item = CPListItem(text: "Before", detailText: nil)
            var calls = 0
            item.handler = { selected, completion in
                calls += 1
                (selected as? CPListItem)?.setText("After")
                completion()
            }
            let source = FakeCarPlayController(templates: [CPListTemplate(
                title: "List",
                sections: [CPListSection(items: [item])]
            )])
            let response = try perform(source, id: "stack/0/sections/0/items/0")
            XCTAssertEqual(response.status, .success)
            XCTAssertEqual(calls, 1)
            XCTAssertEqual(response.simulated, "sdk")
            XCTAssertEqual(response.templates.templates.first?.sections?.first?.items?.first?.text, "After")
        }

        func testImageRowAndElementHandlers() throws {
            let row = CPListImageRowItem(text: "Images", images: [UIImage(), UIImage()])
            var rowCalls = 0
            var indices: [Int] = []
            row.handler = { _, done in rowCalls += 1; done() }
            row.listImageRowHandler = { _, index, done in indices.append(index); done() }
            let source = FakeCarPlayController(templates: [CPListTemplate(
                title: "List",
                sections: [CPListSection(items: [row])]
            )])
            let id = "stack/0/sections/0/items/0"
            XCTAssertEqual(try perform(source, id: id).status, .success)
            XCTAssertEqual(try perform(source, id: "\(id)/buttons/1").status, .success)
            XCTAssertEqual(rowCalls, 1)
            XCTAssertEqual(indices, [1])
            row.isEnabled = false
            XCTAssertEqual(try perform(source, id: "\(id)/buttons/0").status, .failed)
            XCTAssertEqual(indices, [1])
        }

        func testTabsAndNestedSelection() throws {
            let item = CPListItem(text: "Nested", detailText: nil)
            var calls = 0
            item.handler = { _, done in calls += 1; done() }
            let list = CPListTemplate(title: "List", sections: [CPListSection(items: [item])])
            let tabs = CPTabBarTemplate(templates: [CPGridTemplate(title: "Grid", gridButtons: []), list])
            let source = FakeCarPlayController(templates: [tabs])
            let response = try perform(source, id: "stack/0/tabs/1")
            XCTAssertEqual(response.status, .success)
            XCTAssertEqual(source.selectedTab, 1)
            XCTAssertEqual(response.templates.templates[0].tabs?[1].selected, true)
            XCTAssertEqual(response.templates.templates[0].tabs?[0].selected, false)
            XCTAssertEqual(try perform(source, id: "stack/0/tabs/1/template/sections/0/items/0").status, .success)
            XCTAssertEqual(calls, 1)
        }

        func testBackAndPopToRootReturnUpdatedStack() throws {
            let source = FakeCarPlayController(templates: [CPTemplate(), CPTemplate(), CPTemplate()])
            let registry = CarPlayTemplateRegistry()
            registry.register(source)
            var response: CarPlayActionResponse?
            registry.perform(CarPlayActionRequest(action: .back)) { response = $0 }
            XCTAssertEqual(response?.status, .success)
            XCTAssertEqual(response?.templates.templates.count, 2)
            registry.perform(CarPlayActionRequest(action: .popToRoot)) { response = $0 }
            XCTAssertEqual(response?.status, .success)
            XCTAssertEqual(response?.templates.templates.count, 1)
            XCTAssertEqual(source.popCalls, [false, true])
            registry.perform(CarPlayActionRequest(action: .back)) { response = $0 }
            XCTAssertEqual(response?.status, .failed)
            XCTAssertNotNil(response?.reason)
        }

        func testUnknownDisabledMissingHandlerAndUnsupportedGrid() throws {
            let item = CPListItem(text: "Disabled", detailText: nil)
            item.isEnabled = false
            var calls = 0
            item.handler = { _, done in calls += 1; done() }
            let gridButton = CPGridButton(titleVariants: ["Grid"], image: UIImage()) { _ in calls += 1 }
            let source = FakeCarPlayController(templates: [
                CPListTemplate(title: "List", sections: [CPListSection(items: [item])]),
                CPGridTemplate(title: "Grid", gridButtons: [gridButton]),
            ])
            XCTAssertEqual(try perform(source, id: "stack/99").status, .notFound)
            XCTAssertEqual(try perform(source, id: "stack/00").status, .notFound)
            let disabled = try perform(source, id: "stack/0/sections/0/items/0")
            XCTAssertEqual(disabled.status, .failed)
            XCTAssertNotNil(disabled.reason)
            XCTAssertEqual(try perform(source, id: "stack/1/buttons/0").status, .unsupported)
            gridButton.isEnabled = false
            XCTAssertEqual(try perform(source, id: "stack/1/buttons/0").status, .failed)
            item.isEnabled = true
            item.handler = nil
            XCTAssertEqual(try perform(source, id: "stack/0/sections/0/items/0").status, .failed)
            XCTAssertEqual(calls, 0)
        }

        func testPresentedAlertSheetAndPublicOnlyButtons() throws {
            var calls = 0
            let action = CPAlertAction(title: "Confirm", style: .default) { _ in calls += 1 }
            let info = CPInformationTemplate(title: "Info", layout: .leading, items: [], actions: [
                CPTextButton(title: "Text", textStyle: .normal) { _ in calls += 1 },
            ])
            let list = CPListTemplate(title: "List", sections: [])
            let bar = CPBarButton(title: "Bar") { _ in calls += 1 }
            list.leadingNavigationBarButtons = [bar]
            list.trailingNavigationBarButtons = [bar]
            list.backButton = bar
            let source = FakeCarPlayController(templates: [info, list])
            source.presented = CPAlertTemplate(titleVariants: ["Alert"], actions: [action])
            XCTAssertEqual(try perform(source, id: "presented/actions/0").status, .success)
            source.presented = CPActionSheetTemplate(title: "Sheet", message: nil, actions: [action])
            XCTAssertEqual(try perform(source, id: "presented/actions/0").status, .success)
            XCTAssertEqual(try perform(source, id: "stack/0/actions/0").status, .unsupported)
            for path in ["leadingNavigationBarButtons/0", "trailingNavigationBarButtons/0", "backButton/0"] {
                XCTAssertEqual(try perform(source, id: "stack/1/\(path)").status, .unsupported)
            }
            bar.isEnabled = false
            XCTAssertEqual(try perform(source, id: "stack/1/leadingNavigationBarButtons/0").status, .failed)
            XCTAssertEqual(calls, 2)
        }

        private func perform(_ source: FakeCarPlayController, id: String) throws -> CarPlayActionResponse {
            let registry = CarPlayTemplateRegistry()
            registry.register(source)
            var response: CarPlayActionResponse?
            registry.perform(CarPlayActionRequest(id: id)) { response = $0 }
            let value = try XCTUnwrap(response)
            XCTAssertEqual(value.simulated, "sdk")
            XCTAssertTrue(value.templates.connected)
            return value
        }
    }

    @MainActor
    private final class FakeCarPlayController: CarPlayActionSource {
        var templates: [CPTemplate]
        var presented: CPTemplate?
        var selectedTab: Int?
        var popCalls: [Bool] = []

        init(templates: [CPTemplate]) { self.templates = templates }

        func carPlaySnapshot() -> CarPlayTemplateDocument {
            var mapper = CarPlayTemplateMapper()
            let document = mapper.document(templates: templates, presented: presented)
            // Model the host's tab selection without a real interface controller or CarPlay host.
            if let selectedTab {
                for (index, tab) in (document.templates.first?.tabs ?? []).enumerated() {
                    tab.selected = index == selectedTab
                }
            }
            return document
        }

        func carPlaySelect(id: String) -> CarPlayActionOutcome {
            let performer = CarPlayActionPerformer { _, index in self.selectedTab = index }
            return performer.select(id: id, templates: templates, presented: presented)
        }

        func carPlayPop(toRoot: Bool, completion: @escaping @MainActor (CarPlayActionOutcome) -> Void) {
            popCalls.append(toRoot)
            guard templates.count > 1 else {
                completion(CarPlayActionOutcome(status: .failed, reason: "Already at the root."))
                return
            }
            if toRoot { templates = [templates[0]] }
            else { templates.removeLast() }
            completion(CarPlayActionOutcome(status: .success))
        }
    }
#endif
