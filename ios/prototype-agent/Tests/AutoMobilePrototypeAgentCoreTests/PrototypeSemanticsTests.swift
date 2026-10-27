@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeSemanticsTests: XCTestCase {
    func testDecodeAndAccessibleLabelPrecedence() throws {
        let node = try JSONDecoder().decode(
            PrototypeNode.self,
            from: Data(
                #"{"type":"text","text":"Visible","semantics":{"heading":true,"group":true,"label":"Hello {name}","hint":"More","liveRegion":"assertive","traits":["button","image","selected"]}}"#
                    .utf8
            )
        )
        XCTAssertEqual(node.semantics?.heading, true)
        XCTAssertEqual(node.semantics?.group, true)
        XCTAssertEqual(node.semantics?.traits, ["button", "image", "selected"])
        XCTAssertEqual(node.semantics?.hint, "More")
        XCTAssertEqual(
            node.accessibilityLabel(state: ["name": .string("Ada")], pager: nil, tappable: false),
            "Hello Ada"
        )
    }

    func testAnnouncementDecisions() {
        XCTAssertNil(PrototypeAnnouncement.change(previous: nil, current: "First", liveRegion: "polite"))
        XCTAssertNil(PrototypeAnnouncement.change(previous: "Same", current: "Same", liveRegion: "polite"))
        XCTAssertNil(PrototypeAnnouncement.change(previous: "Before", current: "", liveRegion: "assertive"))
        XCTAssertNil(PrototypeAnnouncement.change(previous: "Before", current: "After", liveRegion: nil))
        XCTAssertEqual(
            PrototypeAnnouncement.change(previous: "Before", current: "After", liveRegion: "polite"),
            PrototypeAnnouncement(text: "After", assertive: false)
        )
        XCTAssertEqual(
            PrototypeAnnouncement.change(previous: "Before", current: "After", liveRegion: "assertive"),
            PrototypeAnnouncement(text: "After", assertive: true)
        )
    }

    func testControlAnnouncementUsesNativeLabelText() throws {
        let node = try JSONDecoder().decode(
            PrototypeNode.self,
            from: Data(#"{"type":"button","label":"Send {count}","semantics":{"liveRegion":"polite"}}"#.utf8)
        )
        XCTAssertEqual(node.announcementText(state: ["count": .number(2)], pager: nil), "Send 2")
    }

    func testContainerAnnouncementUsesDescendantText() throws {
        let node = try JSONDecoder().decode(
            PrototypeNode.self,
            from: Data(
                #"{"type":"column","semantics":{"liveRegion":"polite"},"children":[{"type":"text","text":"Hello {name}"},{"type":"text","text":"World"}]}"#
                    .utf8
            )
        )
        XCTAssertEqual(node.announcementText(state: ["name": .string("Ada")], pager: nil), "Hello Ada World")
    }
}
