import Foundation

/// Golden recording (`scripts/ios/prototype-record-goldens.sh`) launches the viewer with
/// `launchArgument`, so a capture never depends on animation timing, the device clock, locale or
/// time zone. Without it, nothing changes: normal viewing and the injected agent read `.off`.
struct PrototypeRecordingMode: Equatable, Sendable {
    /// Two leading dashes keep the flag out of `UserDefaults`' argument domain (`-Key value`).
    static let launchArgument = "--automobile-prototype-recording"

    let enabled: Bool

    static let off = Self(enabled: false)
    static let on = Self(enabled: true)

    static func from(arguments: [String]) -> Self {
        Self(enabled: arguments.dropFirst().contains(launchArgument))
    }

    /// Read once from this process's launch arguments.
    static let current = from(arguments: ProcessInfo.processInfo.arguments)

    static let locale = Locale(identifier: "en_US_POSIX")
    static let timeZone = TimeZone(identifier: "UTC") ?? .gmt
    /// 2026-01-15T12:00:00Z: the clock relative formats and other `now`-dependent text read.
    static let now = Date(timeIntervalSince1970: 1_768_478_400)

    /// Gregorian in UTC with a fixed locale and first weekday, so a calendar's month grid, weekday
    /// headers and month name are the same on every device.
    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.locale = locale
        calendar.firstWeekday = 1
        return calendar
    }()

    /// The locale device-dependent views read: the fixed one while recording, else the device's.
    var locale: Locale { enabled ? Self.locale : .autoupdatingCurrent }

    /// The calendar a date picker shows: the fixed one while recording, else `PrototypeDate`'s.
    var dateCalendar: Calendar { enabled ? Self.calendar : PrototypeDate.calendar }

    /// The format environment while recording; `device` otherwise.
    func formatEnvironment(device: @autoclosure () -> PrototypeFormatEnvironment) -> PrototypeFormatEnvironment {
        enabled ? PrototypeFormatEnvironment(locale: Self.locale, timeZone: Self.timeZone, now: Self.now) : device()
    }
}
