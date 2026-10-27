@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeCarouselTests: XCTestCase {
    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid")
    }

    func testCarouselDecodesItsVariantWidthSpacingAndItems() throws {
        let carousel = try node(#"""
        {"type":"carousel","variant":"hero","itemWidth":280,"itemSpacing":8,
         "children":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}
        """#)
        XCTAssertEqual(carousel.variant, "hero")
        XCTAssertEqual(PrototypeCarousel.itemWidth(carousel), 280)
        XCTAssertEqual(PrototypeCarousel.spacing(carousel), 8)
        XCTAssertEqual(carousel.children?.count, 2)
    }

    func testWidthAndSpacingAreClampedToSaneValues() throws {
        let carousel = try node(#"{"type":"carousel","itemWidth":0.25,"itemSpacing":-4,"children":[]}"#)
        XCTAssertEqual(PrototypeCarousel.itemWidth(carousel), 1)
        XCTAssertEqual(PrototypeCarousel.spacing(carousel), 0)
        XCTAssertEqual(try PrototypeCarousel.itemWidth(node(#"{"type":"carousel","children":[]}"#)), 1)
    }

    func testPagerIndicatorFillsExactlyTheCurrentPageAndClamps() throws {
        XCTAssertEqual(PrototypeCarousel.indicatorDots(count: 3, selected: 1), [false, true, false])
        XCTAssertEqual(PrototypeCarousel.indicatorDots(count: 2, selected: 9), [false, true])
        XCTAssertEqual(PrototypeCarousel.indicatorDots(count: 2, selected: -1), [true, false])
        XCTAssertEqual(PrototypeCarousel.indicatorDots(count: 0, selected: 0), [])
        let dotted = try node(#"{"type":"pager","id":"p","indicator":"dots","children":[]}"#)
        XCTAssertTrue(PrototypeCarousel.showsIndicator(dotted))
        XCTAssertFalse(try PrototypeCarousel.showsIndicator(node(#"{"type":"pager","id":"p","children":[]}"#)))
        XCTAssertFalse(try PrototypeCarousel.showsIndicator(
            node(#"{"type":"pager","id":"p","indicator":"none","children":[]}"#)
        ))
    }

    func testSharedFixturesDecode() throws {
        for name in ["carousel-multi-browse", "carousel-hero-repeat", "pager-indicator-dots"] {
            let spec = try JSONDecoder().decode(
                PrototypeSpec.self,
                from: Data(contentsOf: fixtures.appendingPathComponent(name + ".json"))
            )
            XCTAssertFalse(spec.root.type.isEmpty, name)
        }
    }

    func testCarouselRepeatExpandsOneItemPerRow() throws {
        let spec = try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(contentsOf: fixtures.appendingPathComponent("carousel-hero-repeat.json"))
        )
        XCTAssertEqual(spec.root.type, "carousel")
        XCTAssertEqual(spec.root.children?.count, 2)
        XCTAssertEqual(spec.root.children?.compactMap { $0.children?.first?.text }, ["A", "B"])
    }

    func testTheAccessibilityGroupingTreatsACarouselAsAContainer() {
        XCTAssertEqual(prototypeAccessibilityGrouping(type: "carousel", tappable: false), .contain)
    }

    func testSharedInvalidCarouselFixturesFailAtTheirPathExceptTheChildCount() throws {
        let invalid = fixtures.deletingLastPathComponent().appendingPathComponent("invalid")
        let names = try FileManager.default.contentsOfDirectory(atPath: invalid.path)
            .filter { $0.hasPrefix("carousel-") || $0 == "pager-indicator-unknown.json" }
            .filter { $0 != "carousel-no-children.json" }
            .sorted()
        XCTAssertEqual(names.count, 6)
        for name in names {
            let data = try Data(contentsOf: invalid.appendingPathComponent(name))
            let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let expected = try XCTUnwrap(fixture["expectedPath"] as? String)
            let specData = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture["spec"]))
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: specData), name) { error in
                XCTAssertTrue("\(error)".contains("\(expected):"), "\(name): \(error)")
            }
        }
    }
}
