@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeStylePolishV2Tests: XCTestCase {
    func testConditionalStylesRequireCapability() throws {
        let raw = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"type":"box","styleWhen":[{"style":{"cornerStyle":"continuous"}}]}"#.utf8)
        )
        XCTAssertTrue(PrototypeStylePolishV2.required(raw.objectFields ?? [:]))
        XCTAssertEqual(PrototypeStylePolishV2.capability, "prototype_style_polish_v2")
        XCTAssertFalse(PrototypeStylePolishV2.required(["data": .object(["shadows": .array([])])]))
    }

    func testShadowsExcludeZeroElevationAtAuthoredPath() throws {
        XCTAssertThrowsError(try PrototypeStylePolishV2.validateObject(
            ["shadows": .array([]), "elevation": .number(0)], kind: "style", path: "root.style"
        )) { error in
            XCTAssertTrue(String(describing: error).contains("root.style.shadows"))
            XCTAssertTrue(
                String(describing: error)
                    .contains("shadows cannot be combined with elevation or shadowColor")
            )
        }
    }

    func testGeneratedLayerModelPreservesAuthoredFields() throws {
        let value = try JSONDecoder().decode(
            Shadow.self,
            from: Data(#"{"color":"scrim","radius":0,"spread":-2,"inner":true,"offset":{"x":1,"y":-1}}"#.utf8)
        )
        XCTAssertEqual(value.spread, -2)
        XCTAssertEqual(value.inner, true)
        XCTAssertEqual(value.offset?.x, 1)
    }

    func testStyleMergePreservesAndReplacesLayeredFields() throws {
        let decoder = JSONDecoder()
        let base = try decoder.decode(
            Style.self,
            from: Data(#"{"shadows":[{"color":"scrim","radius":2}],"cornerStyle":"continuous"}"#.utf8)
        )
        let empty = try decoder.decode(Style.self, from: Data("{}".utf8))
        XCTAssertEqual(base.merged(with: empty).shadows, base.shadows)
        XCTAssertEqual(base.merged(with: empty).cornerStyle, "continuous")
        let override = try decoder.decode(
            Style.self,
            from: Data(#"{"shadows":[{"color":"primary","radius":4}],"cornerStyle":"circular"}"#.utf8)
        )
        XCTAssertEqual(base.merged(with: override).shadows, override.shadows)
        XCTAssertEqual(base.merged(with: override).cornerStyle, "circular")
    }
}
