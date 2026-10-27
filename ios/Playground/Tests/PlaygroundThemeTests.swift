import SwiftUI
import UIKit
import XCTest

@testable import Playground

/// Pins the icon-derived palette's WCAG-AA contrast (AC1), the Shantell Sans
/// registration (AC2), and the hand-drawn shape scale (AC3) — mirroring the
/// Android `PlaygroundContrastTest` / `PlaygroundShapesTest`.
final class PlaygroundThemeTests: XCTestCase {
    private func luminance(_ color: Color) -> Double {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        func ch(_ channel: CGFloat) -> Double {
            let component = Double(channel)
            return component <= 0.03928 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * ch(red) + 0.7152 * ch(green) + 0.0722 * ch(blue)
    }

    private func contrast(_ foreground: Color, _ background: Color) -> Double {
        let foregroundLuminance = luminance(foreground), backgroundLuminance = luminance(background)
        return (max(foregroundLuminance, backgroundLuminance) + 0.05) /
            (min(foregroundLuminance, backgroundLuminance) + 0.05)
    }

    private func assertAA(_ name: String, _ foreground: Color, _ background: Color) {
        XCTAssertGreaterThanOrEqual(contrast(foreground, background), 4.5, "\(name) must meet WCAG AA (>= 4.5:1)")
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

    /// Accent roles used as foreground text (links, status labels) must be readable on
    /// the background/surface. tertiary is excluded — it is a fill-only role.
    func testLightAccentRolesReadableAsForeground() {
        assertAA("light primary-as-text/background", .pgLightPrimary, .pgLightBackground)
        assertAA("light primary-as-text/surface", .pgLightPrimary, .pgLightSurface)
        assertAA("light secondary-as-text/background", .pgLightSecondary, .pgLightBackground)
        assertAA("light error-as-text/background", .pgLightError, .pgLightBackground)
    }

    func testDarkAccentRolesReadableAsForeground() {
        assertAA("dark primary-as-text/background", .pgDarkPrimary, .pgDarkBackground)
        assertAA("dark primary-as-text/surface", .pgDarkPrimary, .pgDarkSurface)
        assertAA("dark secondary-as-text/background", .pgDarkSecondary, .pgDarkBackground)
        assertAA("dark error-as-text/background", .pgDarkError, .pgDarkBackground)
    }

    func testShantellSansIsRegistered() {
        let families = UIFont.familyNames
        XCTAssertTrue(
            families.contains { $0.localizedCaseInsensitiveContains("Shantell") },
            "Shantell Sans must be registered via UIAppFonts. Available: \(families)"
        )
    }

    func testUIKitBodyUsesRegisteredThemeFamilyAndBodyScale() {
        let typography = PlaygroundTypography()
        let expected = UIFontMetrics(forTextStyle: .body).scaledValue(for: 16)
        XCTAssertTrue(typography.uiKitBody.familyName.localizedCaseInsensitiveContains("Shantell"))
        XCTAssertEqual(typography.uiKitBody.pointSize, expected, accuracy: 0.01)
    }

    func testFixtureShapeTokensPreserveExistingRadii() {
        let shapes = PlaygroundShapes()
        XCTAssertEqual(shapes.swatch, 4)
        XCTAssertEqual(shapes.thumbnail, 8)
        XCTAssertEqual(shapes.gestureTarget, 16)
        XCTAssertEqual(shapes.layeredBackdrop, 20)
    }

    func testShapeScaleIsChunkyHandDrawn() {
        let shapes = PlaygroundShapes()
        XCTAssertEqual(shapes.extraSmall, 6)
        XCTAssertEqual(shapes.small, 12)
        XCTAssertEqual(shapes.medium, 18)
        XCTAssertEqual(shapes.large, 26)
        XCTAssertEqual(shapes.extraLarge, 40)
        XCTAssertEqual(shapes.button, 14)
        XCTAssertEqual(shapes.card, 18)
        XCTAssertEqual(shapes.textField, 12)
    }
}
