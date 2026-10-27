@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeStyleRenderingTests: XCTestCase {
    private let light = PrototypePalette.make(theme: nil, systemDark: false)
    private let dark = PrototypePalette.make(theme: nil, systemDark: true)
    override class func setUp() {
        super.setUp()
        // XCTest includes instance setup in its reported test duration. Warm the contract's
        // one-time metadata in class setup; fixture decoding is still asserted by its own test.
        do {
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: Data(
                contentsOf:
                PrototypeSpecFixtures.directory.appendingPathComponent("valid/theme-modes-style-polish-v2.json")
            ))
        } catch {
            XCTFail("Cannot decode style polish fixture: \(error)")
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testShadowDefaultsOrderAndCSSBlur() throws {
        let shadows = try decode(
            [Shadow].self,
            ##"[{"color":"#112233","radius":20},{"color":"#445566","radius":0,"inner":true},{"color":"#778899","radius":8,"spread":3,"offset":{"x":-2,"y":4}}]"##
        )
        let layers = PrototypeStyleShadowLayer.resolve(shadows, palette: light)
        XCTAssertEqual(layers.map(\.color), shadows.map { light.resolve($0.color) })
        XCTAssertEqual(layers.map(\.sigma), [10, 0, 4])
        XCTAssertEqual(layers.map(\.spread), [0, 0, 3])
        XCTAssertEqual(layers.map(\.inner), [false, true, false])
        XCTAssertEqual(layers.map(\.x), [0, 0, -2])
        XCTAssertEqual(layers.map(\.y), [0, 0, 4])
        XCTAssertEqual(PrototypeStyleShadowLayer.resolve(nil, palette: light), [])
    }

    func testThemedShadowsAndFilterResolveThroughPalette() throws {
        let shadows = try decode([Shadow].self, ##"[{"color":{"light":"primary","dark":"#FFFFFF"},"radius":2}]"##)
        XCTAssertEqual(PrototypeStyleShadowLayer.resolve(shadows, palette: light)[0].color, light.resolve("primary"))
        XCTAssertEqual(PrototypeStyleShadowLayer.resolve(shadows, palette: dark)[0].color, dark.resolve("#FFFFFF"))
        let filter = try decode(ImageFilter.self, ##"{"saturation":0,"tint":{"light":"primary","dark":"#FFFFFF"}}"##)
        XCTAssertEqual(PrototypeImageFilter(filter, palette: light).saturation, 0)
        XCTAssertEqual(PrototypeImageFilter(filter, palette: light).tint, light.resolve("primary"))
        XCTAssertEqual(PrototypeImageFilter(filter, palette: dark).tint, dark.resolve("#FFFFFF"))
    }

    func testSpreadGeometryAndRadiusClamping() throws {
        let shadows = try decode(
            [Shadow].self,
            ##"[{"color":"scrim","radius":8,"spread":6},{"color":"scrim","radius":8,"spread":6,"inner":true},{"color":"scrim","radius":0,"spread":-20}]"##
        )
        let layers = PrototypeStyleShadowLayer.resolve(shadows, palette: light)
        XCTAssertEqual(layers.map(\.sourceInset), [-6, 6, 20])
        XCTAssertEqual(
            PrototypeStyleCorners.sourceBounds(width: 100, height: 40, spread: 6),
            CGRect(x: -6, y: -6, width: 112, height: 52)
        )
        XCTAssertEqual(
            PrototypeStyleCorners.sourceBounds(width: 100, height: 40, spread: -6),
            CGRect(x: 6, y: 6, width: 88, height: 28)
        )
        XCTAssertNil(PrototypeStyleCorners.sourceBounds(width: 10, height: 10, spread: -20))
        XCTAssertEqual(PrototypeStyleCorners.radii(.uniform(4), width: 100, height: 40, spread: 6), [10, 10, 10, 10])
        XCTAssertEqual(PrototypeStyleCorners.radii(.uniform(4), width: 100, height: 40, spread: -6), [0, 0, 0, 0])
        XCTAssertEqual(PrototypeStyleCorners.radii(.uniform(20), width: 10, height: 10, spread: -20), [0, 0, 0, 0])
        XCTAssertGreaterThan(layers[0].inverseExtent, layers[0].spread + 3 * layers[0].sigma)
    }

    func testFullContinuousCornersStayCapsuleOrCircle() {
        let radius = PrototypeShapes.standard.resolve(.token("full"))
        XCTAssertEqual(PrototypeStyleCorners.radii(radius, width: 200, height: 40), [20, 20, 20, 20])
        XCTAssertEqual(PrototypeStyleCorners.radii(radius, width: 40, height: 40), [20, 20, 20, 20])
        XCTAssertEqual(PrototypeStyleCorners.radii(radius, width: 0, height: 40), [0, 0, 0, 0])
        XCTAssertEqual(
            PrototypeStyleCorners
                .radii(.corners(topStart: 1, topEnd: 2, bottomEnd: 3, bottomStart: 4), width: 100, height: 100),
            [1, 2, 3, 4]
        )
    }

    func testVerticalFadesAtRestMiddleAndEndIgnoreHorizontalEdges() {
        let spec = FadeEdges(top: 12, bottom: 24, start: 99, end: 99)
        func resolve(_ backward: Bool, _ forward: Bool) -> [PrototypeFadeEdges.Fade] {
            PrototypeFadeEdges.resolve(
                axis: "vertical",
                rightToLeft: false,
                canScrollBackward: backward,
                canScrollForward: forward,
                spec: spec
            )
        }
        XCTAssertEqual(resolve(false, true), [.init(edge: .bottom, length: 24)])
        XCTAssertEqual(resolve(true, true), [.init(edge: .top, length: 12), .init(edge: .bottom, length: 24)])
        XCTAssertEqual(resolve(true, false), [.init(edge: .top, length: 12)])
        XCTAssertEqual(resolve(false, false), [])
    }

    func testHorizontalFadesMirrorInRTL() {
        let spec = FadeEdges(top: 100, bottom: 100, start: 10, end: 20)
        XCTAssertEqual(
            PrototypeFadeEdges.resolve(
                axis: "horizontal",
                rightToLeft: false,
                canScrollBackward: true,
                canScrollForward: true,
                spec: spec
            ),
            [.init(edge: .left, length: 10), .init(edge: .right, length: 20)]
        )
        XCTAssertEqual(
            PrototypeFadeEdges.resolve(
                axis: "horizontal",
                rightToLeft: true,
                canScrollBackward: true,
                canScrollForward: true,
                spec: spec
            ),
            [.init(edge: .right, length: 10), .init(edge: .left, length: 20)]
        )
        XCTAssertEqual(
            PrototypeFadeEdges.resolve(
                axis: "horizontal",
                rightToLeft: true,
                canScrollBackward: false,
                canScrollForward: true,
                spec: spec
            ),
            [.init(edge: .left, length: 20)]
        )
        XCTAssertEqual(PrototypeFadeEdges.resolve(
            axis: nil,
            rightToLeft: true,
            canScrollBackward: true,
            canScrollForward: true,
            spec: FadeEdges(top: 0, bottom: nil, start: 12, end: 12)
        ), [])
    }

    func testScrollBoundsAndFadeLength() {
        let rest = PrototypeFadeEdges.scrollability(
            min: 0,
            max: 300,
            viewport: 100,
            horizontal: false,
            rightToLeft: false
        )
        XCTAssertFalse(rest.backward)
        XCTAssertTrue(rest.forward)
        let rtlRest = PrototypeFadeEdges.scrollability(
            min: -200,
            max: 100,
            viewport: 100,
            horizontal: true,
            rightToLeft: true
        )
        XCTAssertFalse(rtlRest.backward)
        XCTAssertTrue(rtlRest.forward)
        let fits = PrototypeFadeEdges.scrollability(
            min: 0,
            max: 50,
            viewport: 100,
            horizontal: false,
            rightToLeft: false
        )
        XCTAssertFalse(fits.backward)
        XCTAssertFalse(fits.forward)
        XCTAssertEqual(PrototypeFadeEdges.fraction(distance: 1000, length: 100), 0.5)
        XCTAssertEqual(PrototypeFadeEdges.fraction(distance: 10, length: 100), 0.1)
        XCTAssertEqual(PrototypeFadeEdges.fraction(distance: 10, length: 0), 0)
    }

    func testFilterDefaultsAndTintOnly() {
        XCTAssertEqual(PrototypeImageFilter(nil, palette: light).saturation, 1)
        XCTAssertNil(PrototypeImageFilter(nil, palette: light).tint)
        let tint = ImageFilter(saturation: nil, tint: "scrim")
        XCTAssertEqual(PrototypeImageFilter(tint, palette: light).saturation, 1)
        XCTAssertEqual(PrototypeImageFilter(tint, palette: light).tint, light.resolve("scrim"))
    }

    func testSharedStylePolishFixtureResolvesEveryField() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("valid/theme-modes-style-polish-v2.json")
        ))
        let scroll = spec.root
        XCTAssertEqual(scroll.fadeEdges, FadeEdges(top: 0, bottom: 24, start: 12, end: 1000))
        let image = try XCTUnwrap(scroll.child)
        XCTAssertEqual(image.type, "image")
        XCTAssertEqual(PrototypeImageFilter(image.filter, palette: light).saturation, 2)
        XCTAssertEqual(PrototypeImageFilter(image.filter, palette: dark).tint, dark.resolve("#FFFFFF"))
        let style = try XCTUnwrap(image.style)
        XCTAssertEqual(style.cornerStyle, "continuous")
        XCTAssertEqual(PrototypeStyleCorners.radii(
            style.cornerRadius.map(PrototypeShapes.standard.resolve),
            width: 100,
            height: 40
        ), [20, 20, 20, 20])
        let layers = PrototypeStyleShadowLayer.resolve(style.shadows, palette: dark)
        XCTAssertEqual(layers.count, 3)
        XCTAssertEqual(layers.map(\.sigma), [10, 500, 0])
        XCTAssertEqual(layers.map(\.spread), [0, -1000, 1000])
        XCTAssertEqual(layers.map(\.x), [0, -1000, 0])
        XCTAssertEqual(layers.map(\.y), [0, 1000, 0])
        XCTAssertEqual(layers.map(\.inner), [false, false, true])
        XCTAssertEqual(layers.map(\.color), [dark.resolve("#000000"), dark.resolve("scrim"), dark.resolve("scrim")])
        let border = try XCTUnwrap(style.border)
        XCTAssertEqual(border.width, 2)
        XCTAssertNil(border.color)
        let gradient = try XCTUnwrap(border.gradient)
        XCTAssertEqual(
            gradient.colorStops(palette: dark).map(\.color),
            [dark.resolve("#000000"), dark.resolve("primary")].compactMap { $0 }
        )
        let active = try XCTUnwrap(image.resolvedStyle(state: ["active": .bool(true)]))
        XCTAssertEqual(active.cornerStyle, "circular")
        XCTAssertEqual(PrototypeStyleShadowLayer.resolve(active.shadows, palette: light).count, 1)
    }
}
