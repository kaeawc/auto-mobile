import Foundation

struct PrototypeValueFormat: Codable, Sendable {
    struct Options: Codable, Sendable {
        let minFraction: Int?
        let maxFraction: Int?
        let grouping: Bool?
        let style: String?
        let code: String?
    }

    let number: Options?
    let compact: Options?
    let currency: Options?
    let percent: Options?
    let date: Options?
    let time: Options?
    let relative: Options?
}

/// The contract constrains sources differently at the spec and repeat boundaries.
struct PrototypeDerivedEntry: Codable, Sendable {
    let of: [String: JSONValue]
    let format: PrototypeValueFormat
    let locale: String?
    let timeZone: String?

    func environment(_ defaults: PrototypeFormatEnvironment) -> PrototypeFormatEnvironment? {
        guard timeZone == nil || TimeZone(identifier: timeZone ?? "") != nil else { return nil }
        return PrototypeFormatEnvironment(
            locale: locale.map { Locale(identifier: $0) } ?? defaults.locale,
            timeZone: timeZone.flatMap(TimeZone.init(identifier:)) ?? defaults.timeZone,
            now: defaults.now
        )
    }
}

struct PrototypeFormatEnvironment {
    let locale: Locale
    let timeZone: TimeZone
    let now: Date

    static func device(clock: PrototypeClock = SystemPrototypeClock()) -> Self {
        Self(
            locale: .autoupdatingCurrent,
            timeZone: .current,
            now: Date(timeIntervalSince1970: Double(clock.nowMilliseconds) / 1000)
        )
    }
}

protocol PrototypeValueFormatter {
    func format(_ input: JSONValue?, format: PrototypeValueFormat, environment: PrototypeFormatEnvironment) -> String
}

struct FoundationPrototypeValueFormatter: PrototypeValueFormatter {
    func format(
        _ input: JSONValue?,
        format: PrototypeValueFormat,
        environment env: PrototypeFormatEnvironment
    )
        -> String
    {
        if format.date != nil || format.time != nil || format.relative != nil {
            guard let date = Self.parseDate(input) else { return "" }
            if let options = format.relative { return relative(date, options: options, environment: env) }
            // DateFormatter is ICU-backed and honours the same short/medium/long patterns as the host
            // and Android, where Date.FormatStyle's numeric/standard styles pick different patterns.
            let formatter = DateFormatter()
            formatter.locale = env.locale
            formatter.calendar = env.locale.calendar
            formatter.timeZone = env.timeZone
            formatter.dateStyle = format.date.map { Self.style($0.style, default: .medium) } ?? .none
            formatter.timeStyle = format.time.map { Self.style($0.style, default: .short) } ?? .none
            return formatter.string(from: date)
        }
        guard let number = input?.numberValue, number.isFinite else { return "" }
        if let options = format.number {
            let minimum = options.minFraction ?? 0
            let maximum = options.maxFraction ?? max(3, minimum)
            guard (0 ... 20).contains(minimum), (minimum ... 20).contains(maximum) else { return "" }
            var style = FloatingPointFormatStyle<Double>.number.locale(env.locale)
                .rounded(rule: .toNearestOrAwayFromZero)
                .precision(.fractionLength(minimum ... maximum))
            if options.grouping == false { style = style.grouping(.never) }
            return number.formatted(style)
        }
        if let options = format.currency, let code = options.code {
            return number.formatted(.currency(code: code).locale(env.locale).rounded(rule: .toNearestOrAwayFromZero))
        }
        if let options = format.percent {
            let maximum = options.maxFraction ?? max(0, options.minFraction ?? 0)
            let minimum = options.minFraction ?? 0
            guard (0 ... 20).contains(minimum), (minimum ... 20).contains(maximum) else { return "" }
            return number
                .formatted(
                    .percent.locale(env.locale).rounded(rule: .toNearestOrAwayFromZero)
                        .precision(.fractionLength(minimum ... maximum))
                )
        }
        if format.compact != nil {
            // Foundation exposes compactName (short) only; long currently uses that native style.
            return number
                .formatted(.number.locale(env.locale).rounded(rule: .toNearestOrAwayFromZero).notation(.compactName))
        }
        return ""
    }

    private static func style(_ name: String?, default fallback: DateFormatter.Style) -> DateFormatter.Style {
        switch name {
        case "short": .short
        case "medium": .medium
        case "long": .long
        default: fallback
        }
    }

    private func relative(
        _ date: Date, options: PrototypeValueFormat.Options, environment env: PrototypeFormatEnvironment
    )
        -> String
    {
        let difference = date.timeIntervalSince(env.now)
        guard difference.isFinite else { return "" }
        let units: [(Double, Calendar.Component)] = [
            (31_536_000, .year), (2_592_000, .month), (86400, .day),
            (3600, .hour), (60, .minute), (1, .second),
        ]
        let unit = units.first { abs(difference) >= $0.0 } ?? (1, .second)
        guard let value = Int(exactly: (difference / unit.0).rounded(.towardZero)) else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = env.locale
        formatter.dateTimeStyle = abs(difference) < 1 ? .named : .numeric
        formatter.unitsStyle = switch options.style ?? "long" {
        case "short": .short
        case "narrow": .abbreviated
        default: .full
        }
        var components = DateComponents()
        components.setValue(value, for: unit.1)
        return formatter.localizedString(from: components)
    }

    private static func parseDate(_ input: JSONValue?) -> Date? {
        if let number = input?.numberValue {
            guard number.isFinite, number.rounded() == number, abs(number) <= 8_640_000_000_000_000 else { return nil }
            return Date(timeIntervalSince1970: number / 1000)
        }
        guard let text = input?.stringValue,
              text.range(
                  of: #"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$"#,
                  options: .regularExpression
              ) != nil else { return nil }
        if text.count > 10 {
            let parts = Array(text)
            guard let hour = Int(String(parts[11 ... 12])), hour < 24,
                  let minute = Int(String(parts[14 ... 15])), minute < 60,
                  let second = Int(String(parts[17 ... 18])), second < 60 else { return nil }
            if !text.hasSuffix("Z") {
                let offset = Array(text.suffix(6))
                guard let hours = Int(String(offset[1 ... 2])), hours < 24,
                      let minutes = Int(String(offset[4 ... 5])), minutes < 60 else { return nil }
            }
        }
        let day = String(text.prefix(10))
        let calendarParser = DateFormatter()
        calendarParser.locale = Locale(identifier: "en_US_POSIX")
        calendarParser.calendar = Calendar(identifier: .gregorian)
        calendarParser.timeZone = TimeZone(secondsFromGMT: 0)
        calendarParser.dateFormat = "yyyy-MM-dd"
        calendarParser.isLenient = false
        guard let midnight = calendarParser.date(from: day),
              calendarParser.string(from: midnight) == day else { return nil }
        if text.count == 10 { return midnight }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = text
            .contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return parser.date(from: text)
    }
}

enum PrototypeDerivedValues {
    static func resolve(
        _ entry: PrototypeDerivedEntry, state: [String: JSONValue], data: [String: JSONValue]?,
        formatter: PrototypeValueFormatter, environment: PrototypeFormatEnvironment
    )
        -> String
    {
        guard let env = entry.environment(environment) else { return "" }
        let input: JSONValue?
        if let value = entry.of["value"] { input = value }
        else if let pointer = entry.of["data"]?
            .stringValue { input = PrototypeDataPointer.resolve(data, pointer: pointer) }
        else { input = entry.of["state"]?.stringValue.flatMap { state[$0] } }
        return formatter.format(input, format: entry.format, environment: env)
    }

    /// Read every source from the original row. Relative strings refresh only on (re)build.
    static func project(
        _ item: [String: JSONValue], derive: [String: PrototypeDerivedEntry],
        formatter: PrototypeValueFormatter, environment: PrototypeFormatEnvironment
    )
        -> [String: JSONValue]
    {
        var projected = item
        for (name, entry) in derive {
            let input = entry.of["value"] ?? entry.of["item"]?.stringValue.flatMap { item[$0] }
            projected[name] = .string(entry.environment(environment).map {
                formatter.format(input, format: entry.format, environment: $0)
            } ?? "")
        }
        return projected
    }
}

/// A render's values and formatting seams. State is passed by each interpolation call.
struct PrototypeDerivedContext {
    let entries: [String: PrototypeDerivedEntry]
    let data: [String: JSONValue]?
    var formatter: PrototypeValueFormatter = FoundationPrototypeValueFormatter()
    var environment: PrototypeFormatEnvironment = .device()

    func resolve(_ name: String, state: [String: JSONValue]) -> String? {
        entries[name].map {
            PrototypeDerivedValues.resolve($0, state: state, data: data, formatter: formatter, environment: environment)
        }
    }
}
