import SwiftUI
import UIKit
import XCTest

@testable import Playground

/// Pins the icon-derived palette's WCAG-AA contrast (AC1), the Shantell Sans
/// registration (AC2), and the hand-drawn shape scale (AC3) — mirroring the
/// Android `PlaygroundContrastTest` / `PlaygroundShapesTest`.
final class PlaygroundThemeTests: XCTestCase {

    private func luminance(_ color: Color) -> Double {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        func ch(_ c: CGFloat) -> Double {
            let d = Double(c)
            return d <= 0.03928 ? d / 12.92 : pow((d + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
    }

    private func contrast(_ fg: Color, _ bg: Color) -> Double {
        let l1 = luminance(fg), l2 = luminance(bg)
        return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
    }

    private func assertAA(_ name: String, _ fg: Color, _ bg: Color) {
        XCTAssertGreaterThanOrEqual(contrast(fg, bg), 4.5, "\(name) must meet WCAG AA (>= 4.5:1)")
    }

    func testLightTextRolesMeetAA() {
        assertAA("light onBackground/background", .pgLightOnBackground, .pgLightBackground)
        assertAA("light onSurface/surface", .pgLightOnSurface, .pgLightSurface)
        assertAA("light onPrimary/primary", .pgLightOnPrimary, .pgLightPrimary)
        assertAA("light onSecondary/secondary", .pgLightOnSecondary, .pgLightSecondary)
        assertAA("light onTertiary/tertiary", .pgLightOnTertiary, .pgLightTertiary)
        assertAA("light onError/error", .pgLightOnError, .pgLightError)
    }

    func testDarkTextRolesMeetAA() {
        assertAA("dark onBackground/background", .pgDarkOnBackground, .pgDarkBackground)
        assertAA("dark onSurface/surface", .pgDarkOnSurface, .pgDarkSurface)
        assertAA("dark onPrimary/primary", .pgDarkOnPrimary, .pgDarkPrimary)
        assertAA("dark onSecondary/secondary", .pgDarkOnSecondary, .pgDarkSecondary)
        assertAA("dark onTertiary/tertiary", .pgDarkOnTertiary, .pgDarkTertiary)
        assertAA("dark onError/error", .pgDarkOnError, .pgDarkError)
    }

    func testShantellSansIsRegistered() {
        let families = UIFont.familyNames
        XCTAssertTrue(
            families.contains { $0.localizedCaseInsensitiveContains("Shantell") },
            "Shantell Sans must be registered via UIAppFonts. Available: \(families)"
        )
    }

    func testShapeScaleIsChunkyHandDrawn() {
        let s = PlaygroundShapes()
        XCTAssertEqual(s.extraSmall, 6)
        XCTAssertEqual(s.small, 12)
        XCTAssertEqual(s.medium, 18)
        XCTAssertEqual(s.large, 26)
        XCTAssertEqual(s.extraLarge, 40)
        XCTAssertEqual(s.button, 14)
        XCTAssertEqual(s.card, 18)
        XCTAssertEqual(s.textField, 12)
    }
}
