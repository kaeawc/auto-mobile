import Foundation

/// The month grid a recording-mode `datePicker` draws instead of SwiftUI's graphical picker, whose
/// UIKit calendar keeps scrolling and laying out its month after a capture looks stable (#17871).
/// Everything a frame shows comes from here, so the same inputs always draw the same calendar.
struct PrototypeCalendarMonth: Equatable, Sendable {
    /// A fixed six-week grid, so the picker's height never depends on the month.
    static let weekCount = 6

    let year: Int
    let month: Int
    /// `October 2026` in the calendar's locale.
    let title: String
    /// Seven narrow-to-short weekday headers starting at the calendar's first weekday (`SUN` first).
    let weekdaySymbols: [String]
    /// `weekCount` rows of seven cells; nil cells fall outside the month.
    let weeks: [[Int?]]
    /// The selected day when the selection falls in this month.
    let selectedDay: Int?

    /// The month containing `showing`, with `selected` marked when it is in that month.
    static func make(showing: Date, selected: Date?, calendar: Calendar) -> Self {
        let shown = calendar.dateComponents([.year, .month], from: showing)
        let year = shown.year ?? 1970
        let month = shown.month ?? 1
        let first = calendar.date(from: DateComponents(year: year, month: month, day: 1)) ?? showing
        let days = calendar.range(of: .day, in: .month, for: first)?.count ?? 30
        let leading = (calendar.component(.weekday, from: first) - calendar.firstWeekday + 7) % 7
        let cells: [Int?] = Array(repeating: nil, count: leading) + (1 ... days).map(Optional.some)
        let padded = cells + Array(repeating: nil, count: weekCount * 7 - cells.count)
        let weeks = (0 ..< weekCount).map { Array(padded[$0 * 7 ..< $0 * 7 + 7]) }
        let symbols = calendar.shortStandaloneWeekdaySymbols
        let start = calendar.firstWeekday - 1
        let ordered = (0 ..< 7).map { symbols[(start + $0) % symbols.count].uppercased(with: calendar.locale) }
        let picked = selected.map { calendar.dateComponents([.year, .month, .day], from: $0) }
        return Self(
            year: year,
            month: month,
            title: title(of: first, calendar: calendar),
            weekdaySymbols: ordered,
            weeks: weeks,
            selectedDay: picked?.year == year && picked?.month == month ? picked?.day : nil
        )
    }

    /// The first day of the month `offset` months from `date`.
    static func month(of date: Date, offset: Int, calendar: Calendar) -> Date {
        let parts = calendar.dateComponents([.year, .month], from: date)
        let first = calendar.date(from: DateComponents(year: parts.year, month: parts.month, day: 1)) ?? date
        return calendar.date(byAdding: .month, value: offset, to: first) ?? first
    }

    /// Midnight of `day` in this month, in `calendar`'s time zone.
    func date(day: Int, calendar: Calendar) -> Date? {
        calendar.date(from: DateComponents(year: year, month: month, day: day))
    }

    private static func title(of date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = calendar.locale ?? Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMMMy")
        return formatter.string(from: date)
    }
}

extension PrototypeRecordingMode {
    /// A `datePicker`'s selection: the bound `YYYY-MM-DD` day, else the pinned recording day while
    /// recording, else the earliest accepted day, as normal viewing always has.
    func datePickerSelection(bound: String?) -> Date {
        if let date = bound.flatMap(PrototypeDate.date(from:)) { return date }
        guard enabled else { return PrototypeDate.range.lowerBound }
        return PrototypeDate.date(from: PrototypeDate.string(from: Self.now)) ?? Self.now
    }
}
