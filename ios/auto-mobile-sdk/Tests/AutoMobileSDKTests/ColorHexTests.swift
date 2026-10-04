@testable import AutoMobileSDK
import XCTest

final class ColorHexTests: XCTestCase {
    func testDisplayP3RedClampsExtendedSRGBComponents() {
        XCTAssertEqual(ColorHex.rgbaHex(red: 1.0928, green: -0.2269, blue: -0.1501, alpha: 1), "#FF0000FF")
    }

    func testNonFiniteComponentsReturnNil() {
        for value in [Double.nan, Double.infinity, -Double.infinity] {
            XCTAssertNil(ColorHex.rgbaHex(red: value, green: 0.5, blue: 0.5, alpha: 1))
            XCTAssertNil(ColorHex.rgbaHex(red: 0.5, green: value, blue: 0.5, alpha: 1))
            XCTAssertNil(ColorHex.rgbaHex(red: 0.5, green: 0.5, blue: value, alpha: 1))
            XCTAssertNil(ColorHex.rgbaHex(red: 0.5, green: 0.5, blue: 0.5, alpha: value))
        }
    }

    func testInRangeComponentsMatchLegacyFormatting() {
        let colors: [[Double]] = [
            [0, 0, 0, 0],
            [0.5, 0.5, 0.5, 1],
            [1, 1, 1, 1],
            [0.999, 0, 0, 1],
            [0, 0.5, 1, 0.999],
            [0.1, 0.2, 0.3, 0.4],
            [0.75, 0.25, 0.125, 0.875],
            [0.999, 0.999, 0.999, 0.999],
        ]
        for color in colors {
            XCTAssertEqual(
                ColorHex.rgbaHex(red: color[0], green: color[1], blue: color[2], alpha: color[3]),
                legacyHex(color[0], color[1], color[2], color[3])
            )
        }
        XCTAssertEqual(ColorHex.rgbaHex(red: 0.5, green: 0.5, blue: 0.5, alpha: 1), "#7F7F7FFF")
        XCTAssertEqual(ColorHex.rgbaHex(red: 0.999, green: 0, blue: 0, alpha: 1), "#FE0000FF")
    }

    func testEveryByteStepMatchesLegacyFormatting() {
        for i in 0 ... 255 {
            let value = Double(i) / 255.0
            XCTAssertEqual(
                ColorHex.rgbaHex(red: value, green: value, blue: value, alpha: 1),
                legacyHex(value, value, value, 1)
            )
            XCTAssertEqual(
                ColorHex.rgbaHex(red: value, green: 0.5, blue: 1 - value, alpha: value),
                legacyHex(value, 0.5, 1 - value, value)
            )
        }
    }

    func testAlphaClampsWithoutOmittingTransparentColors() {
        XCTAssertEqual(ColorHex.rgbaHex(red: 1, green: 1, blue: 1, alpha: -1), "#FFFFFF00")
        XCTAssertEqual(ColorHex.rgbaHex(red: 1, green: 1, blue: 1, alpha: 2), "#FFFFFFFF")
    }

    func testOutOfRangeColorChannelsClamp() {
        XCTAssertEqual(ColorHex.rgbaHex(red: -0.5, green: 1.5, blue: 0.5, alpha: 1), "#00FF7FFF")
    }

    func testExtremeFiniteComponentsAlwaysProduceEightHexDigits() throws {
        let greatest = Double.greatestFiniteMagnitude
        let colors: [[Double]] = [
            [1e9, -1e9, 0.5, 1],
            [-1e9, 1e9, -1e9, 1e9],
            [greatest, -greatest, greatest, -greatest],
            [-greatest, greatest, -greatest, greatest],
        ]
        for color in colors {
            let hex = try XCTUnwrap(
                ColorHex.rgbaHex(red: color[0], green: color[1], blue: color[2], alpha: color[3])
            )
            XCTAssertNotNil(hex.range(of: "^#[0-9A-F]{8}$", options: .regularExpression))
        }
    }

    private func legacyHex(_ r: Double, _ g: Double, _ b: Double, _ a: Double) -> String {
        String(format: "#%02X%02X%02X%02X", Int(r * 255), Int(g * 255), Int(b * 255), Int(a * 255))
    }
}
