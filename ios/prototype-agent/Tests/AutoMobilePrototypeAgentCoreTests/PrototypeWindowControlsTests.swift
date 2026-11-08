@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

@MainActor
final class PrototypeWindowControlsTests: XCTestCase {
    private final class IdleTimer: PrototypeApplicationIdleTimer {
        var isIdleTimerDisabled: Bool
        init(disabled: Bool) { isIdleTimerDisabled = disabled }
    }

    private final class Screen: PrototypeWindowScreen {
        var ignoresAssignments = false
        private var value = 0.63
        var brightness: Double {
            get { value }
            set { if !ignoresAssignments { value = newValue } }
        }
    }

    private final class Chrome: PrototypeWindowChrome {
        var orientations: [PrototypeWindowOrientation?] = []
        var styles: [PrototypeWindowStatusBar?] = []
        var restores = 0
        var orientationResult = "requested"
        func requestOrientation(_ orientation: PrototypeWindowOrientation?) -> String {
            orientations.append(orientation)
            return orientationResult
        }

        func setStatusBar(_ style: PrototypeWindowStatusBar?) { styles.append(style) }
        func restore() { restores += 1 }
    }

    private func controls(_ json: String) throws -> PrototypeWindowControls {
        // Exercise the production WindowSpec decoder, not a parallel test-only shape.
        try JSONDecoder().decode(WindowSpec.self, from: Data(json.utf8)).controls
    }

    func testApplyAndDismissRestoreBothPreviousIdleTimerValuesAndBrightness() throws {
        for previous in [false, true] {
            let idle = IdleTimer(disabled: previous)
            let screen = Screen()
            let chrome = Chrome()
            let runtime = PrototypeWindowControlsRuntime(idleTimer: idle, screen: screen, chrome: chrome)
            let result = try runtime.apply(controls("""
            {"placement":{"type":"fullscreen"},"keepScreenOn":\(!previous),"brightness":20,
             "orientation":"landscape","statusBar":"light"}
            """))
            XCTAssertEqual(idle.isIdleTimerDisabled, !previous)
            XCTAssertEqual(screen.brightness, 0.2)
            XCTAssertEqual(result?["brightness"], .object(["requested": .number(20), "applied": .number(20)]))
            XCTAssertEqual(result?["orientation"], .string("requested"))
            XCTAssertEqual(chrome.orientations, [.landscape])
            XCTAssertEqual(chrome.styles, [.light])
            runtime.apply(nil)
            XCTAssertEqual(idle.isIdleTimerDisabled, previous)
            XCTAssertEqual(screen.brightness, 0.63)
            XCTAssertEqual(chrome.orientations, [.landscape, nil])
            XCTAssertEqual(chrome.styles, [.light, nil])
            XCTAssertEqual(chrome.restores, 1)
            XCTAssertNil(runtime.apply(nil))
        }
    }

    func testKeepScreenOnRestoresAnAlreadyDisabledHostTimer() throws {
        let idle = IdleTimer(disabled: true)
        let runtime = PrototypeWindowControlsRuntime(idleTimer: idle, screen: Screen(), chrome: Chrome())
        try runtime.apply(controls(#"{"placement":{"type":"fullscreen"},"keepScreenOn":true}"#))
        runtime.apply(nil)
        XCTAssertTrue(idle.isIdleTimerDisabled)
    }

    func testReplacementKeepsOriginalSnapshotAndRemovingFieldsRestoresImmediately() throws {
        let idle = IdleTimer(disabled: true)
        let screen = Screen()
        let chrome = Chrome()
        let runtime = PrototypeWindowControlsRuntime(idleTimer: idle, screen: screen, chrome: chrome)
        let first =
            try controls(
                #"{"placement":{"type":"fullscreen"},"keepScreenOn":false,"brightness":10,"orientation":"portrait","statusBar":"dark"}"#
            )
        runtime.apply(first)
        XCTAssertNil(runtime.apply(first))
        try runtime
            .apply(
                controls(
                    #"{"placement":{"type":"fullscreen"},"keepScreenOn":true,"brightness":90,"orientation":"unlocked","statusBar":"auto"}"#
                )
            )
        XCTAssertEqual(screen.brightness, 0.9)
        XCTAssertEqual(chrome.orientations, [.portrait, .unlocked])
        XCTAssertEqual(chrome.styles, [.dark, .auto])
        try runtime.apply(controls(#"{"placement":{"type":"fullscreen"},"brightness":"system"}"#))
        XCTAssertTrue(idle.isIdleTimerDisabled)
        XCTAssertEqual(screen.brightness, 0.63)
        XCTAssertEqual(chrome.orientations, [.portrait, .unlocked, nil])
        XCTAssertEqual(chrome.styles, [.dark, .auto, nil])
        runtime.apply(nil)
        // A later prototype snapshots the host's newly chosen values.
        idle.isIdleTimerDisabled = false
        screen.brightness = 0.45
        runtime.apply(first)
        runtime.apply(nil)
        XCTAssertFalse(idle.isIdleTimerDisabled)
        XCTAssertEqual(screen.brightness, 0.45)
    }

    func testBrightnessReportReadsBackTheScreenEvenWhenAssignmentsAreIgnored() throws {
        let screen = Screen()
        screen.ignoresAssignments = true
        let runtime = PrototypeWindowControlsRuntime(
            idleTimer: IdleTimer(disabled: false),
            screen: screen,
            chrome: Chrome()
        )
        let result = try runtime.apply(controls(#"{"placement":{"type":"fullscreen"},"brightness":100}"#))
        XCTAssertEqual(result?["brightness"], .object(["requested": .number(100), "applied": .number(63)]))
        runtime.apply(nil)
        XCTAssertEqual(screen.brightness, 0.63)
    }

    func testOrientationUnavailabilityIsReported() throws {
        let chrome = Chrome()
        chrome.orientationResult = "unavailable: no window scene"
        let runtime = PrototypeWindowControlsRuntime(
            idleTimer: IdleTimer(disabled: false), screen: Screen(), chrome: chrome
        )
        let result = try runtime.apply(controls(#"{"placement":{"type":"fullscreen"},"orientation":"portrait"}"#))
        XCTAssertEqual(result?["orientation"], .string("unavailable: no window scene"))
    }

    func testAbsentAndSystemControlsLeaveHostValuesUntouched() throws {
        let idle = IdleTimer(disabled: true)
        let screen = Screen()
        let chrome = Chrome()
        let runtime = PrototypeWindowControlsRuntime(idleTimer: idle, screen: screen, chrome: chrome)
        let result = try runtime.apply(controls(#"{"placement":{"type":"fullscreen"},"brightness":"system"}"#))
        XCTAssertEqual(result?["brightness"], .object(["requested": .string("system"), "applied": .number(63)]))
        XCTAssertTrue(idle.isIdleTimerDisabled)
        XCTAssertEqual(screen.brightness, 0.63)
        XCTAssertTrue(chrome.orientations.isEmpty)
        XCTAssertTrue(chrome.styles.isEmpty)
    }

    func testWindowControlDecodingRejectsInvalidValues() {
        for field in [
            #""brightness":101"#,
            #""brightness":-1"#,
            #""brightness":"bright""#,
            #""orientation":"sideways""#,
            #""statusBar":"hidden""#,
        ] {
            XCTAssertThrowsError(try controls("{\"placement\":{\"type\":\"fullscreen\"},\(field)}"))
        }
    }
}
