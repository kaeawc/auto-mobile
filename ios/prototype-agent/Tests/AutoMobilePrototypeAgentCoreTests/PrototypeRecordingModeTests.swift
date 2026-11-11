@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRecordingModeTests: XCTestCase {
    private struct Accessibility: PrototypeAccessibilityProviding {
        var isReduceMotionEnabled = false
        var prefersCrossFadeTransitions = false
    }

    private let flag = PrototypeRecordingMode.launchArgument

    func testOnlyTheLaunchArgumentAfterTheExecutableEnablesRecording() {
        XCTAssertTrue(PrototypeRecordingMode.from(arguments: ["Viewer", flag]).enabled)
        XCTAssertTrue(PrototypeRecordingMode.from(arguments: ["Viewer", "--other", flag]).enabled)
        XCTAssertFalse(PrototypeRecordingMode.from(arguments: ["Viewer"]).enabled)
        XCTAssertFalse(PrototypeRecordingMode.from(arguments: []).enabled)
        XCTAssertFalse(PrototypeRecordingMode.from(arguments: [flag]).enabled)
        XCTAssertFalse(
            PrototypeRecordingMode.from(arguments: ["Viewer", "\(flag)=1", "-automobile-prototype-recording"]).enabled
        )
    }

    func testTheTestProcessIsNotRecording() {
        XCTAssertEqual(PrototypeRecordingMode.current, .off)
    }

    func testRecordingTurnsMotionOffSoSpinnersAndDialogsDoNotAnimate() {
        let full = Accessibility()
        let recorded = PrototypeMotion(specMotion: nil, reduceMotion: false, accessibility: full, recording: .on)
        XCTAssertEqual(recorded.profile, .off)
        XCTAssertFalse(recorded.spatial)
        XCTAssertFalse(recorded.enabled)
        XCTAssertNil(recorded.fadeDuration)
        XCTAssertNil(recorded.containerSizeDuration)
        XCTAssertEqual(recorded.visibility(transition: "scale"), .instant)
        XCTAssertEqual(recorded.visibility(transition: "none", shared: true), .instant)
        XCTAssertEqual(
            PrototypeMotion(
                specMotion: "reduced", reduceMotion: true,
                accessibility: Accessibility(isReduceMotionEnabled: true), recording: .on
            ).profile,
            .off
        )
    }

    func testNormalViewingKeepsEveryMotionProfile() {
        func profile(_ spec: String?, reduce: Bool = false) -> PrototypeMotionProfile {
            PrototypeMotion(
                specMotion: spec, reduceMotion: reduce, accessibility: Accessibility(), recording: .off
            ).profile
        }
        XCTAssertEqual(profile(nil), .full)
        XCTAssertEqual(profile("reduced"), .reduced)
        XCTAssertEqual(profile(nil, reduce: true), .reduced)
        XCTAssertEqual(profile("none"), .off)
    }

    func testRecordingPinsTheFormatEnvironment() {
        let device = PrototypeFormatEnvironment(
            locale: Locale(identifier: "de_DE"),
            timeZone: TimeZone(identifier: "Asia/Tokyo") ?? .gmt,
            now: Date(timeIntervalSince1970: 42)
        )
        let recorded = PrototypeRecordingMode.on.formatEnvironment(device: device)
        XCTAssertEqual(recorded.locale.identifier, "en_US_POSIX")
        assertUTC(recorded.timeZone)
        XCTAssertEqual(recorded.now, PrototypeRecordingMode.now)
        XCTAssertEqual(PrototypeDate.string(from: PrototypeRecordingMode.now), "2026-01-15")

        let viewing = PrototypeRecordingMode.off.formatEnvironment(device: device)
        XCTAssertEqual(viewing.locale.identifier, "de_DE")
        XCTAssertEqual(viewing.timeZone.identifier, "Asia/Tokyo")
        XCTAssertEqual(viewing.now, Date(timeIntervalSince1970: 42))
    }

    func testTheDeviceEnvironmentUsesTheFixedClockOnlyWhileRecording() {
        let clock = PrototypeLibraryFakeClock()
        let recorded = PrototypeFormatEnvironment.device(clock: clock, recording: .on)
        XCTAssertEqual(recorded.now, PrototypeRecordingMode.now)
        assertUTC(recorded.timeZone)
        let viewing = PrototypeFormatEnvironment.device(clock: clock, recording: .off)
        XCTAssertEqual(viewing.now, Date(timeIntervalSince1970: 1))
        XCTAssertEqual(viewing.timeZone, .current)
    }

    func testRecordingPinsTheDatePickerCalendarAndLocale() {
        let calendar = PrototypeRecordingMode.on.dateCalendar
        XCTAssertEqual(calendar.identifier, .gregorian)
        assertUTC(calendar.timeZone)
        XCTAssertEqual(calendar.locale?.identifier, "en_US_POSIX")
        XCTAssertEqual(calendar.firstWeekday, 1)
        XCTAssertEqual(PrototypeRecordingMode.on.locale.identifier, "en_US_POSIX")

        XCTAssertEqual(PrototypeRecordingMode.off.dateCalendar, PrototypeDate.calendar)
        XCTAssertEqual(PrototypeRecordingMode.off.locale, .autoupdatingCurrent)
    }

    /// Apple's Foundation names `TimeZone(identifier: "UTC")` "GMT"; the zone, not its name, is pinned.
    private func assertUTC(_ zone: TimeZone, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(zone, PrototypeRecordingMode.timeZone, file: file, line: line)
        XCTAssertEqual(zone.secondsFromGMT(for: PrototypeRecordingMode.now), 0, file: file, line: line)
        XCTAssertEqual(zone.secondsFromGMT(for: Date(timeIntervalSince1970: 1_783_000_000)), 0, file: file, line: line)
    }
}
