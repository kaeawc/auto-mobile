import Foundation

/// The `notifications` module report (#14277), the twin of TypeScript's `prototypeNotificationsReport`:
/// it builds `{permission, badge, channels, active, pending}` from a platform snapshot whose `posted`
/// and `pending` entries carry the platform `tag`. Only `proto:<id>` tags are reported, as `id`. Both
/// replay `test/fixtures/prototype-notifications/report.json`.
///
/// On iOS the runtime fills the snapshot from `deliveredNotifications()` and
/// `pendingNotificationRequests()`, with the request identifier as `tag`.
public enum PrototypeNotificationsReport {
    public static let tagPrefix = "proto:"

    /// The prototype notification id a `proto:<id>` tag names, or nil for any other tag.
    public static func id(ofTag tag: JSONValue?) -> String? {
        guard let text = tag?.stringValue, text.hasPrefix(tagPrefix), text.count > tagPrefix.count else {
            return nil
        }
        return String(text.dropFirst(tagPrefix.count))
    }

    public static func of(_ snapshot: JSONValue) -> JSONValue {
        let input = snapshot.objectFields ?? [:]
        let badge = finite(input["badge"])
        let validBadge = badge.map { $0 >= 0 && $0 == $0.rounded(.towardZero) } ?? false
        return .object([
            "permission": .string(input["permission"]?.stringValue ?? "unavailable"),
            "badge": validBadge ? .number(badge ?? 0) : .number(0),
            "channels": .array(
                entries(input["channels"]).compactMap(channel).sorted { $0.id < $1.id }.map(\.json)
            ),
            "active": .array(entries(input["posted"]).compactMap(active).sorted(by: ordered).map(\.json)),
            "pending": .array(entries(input["pending"]).compactMap(pending).sorted(by: ordered).map(\.json)),
        ])
    }

    private struct Sorted {
        let id: String
        let time: Double
        let json: JSONValue
    }

    private static func ordered(_ left: Sorted, _ right: Sorted) -> Bool {
        left.time != right.time ? left.time < right.time : left.id < right.id
    }

    private static func channel(_ entry: [String: JSONValue]) -> Sorted? {
        guard let id = entry["id"]?.stringValue, let importance = entry["importance"]?.stringValue else {
            return nil
        }
        return Sorted(id: id, time: 0, json: .object([
            "id": .string(id),
            "importance": .string(importance),
            "blocked": .bool(entry["blocked"]?.boolValue == true),
        ]))
    }

    private static func active(_ entry: [String: JSONValue]) -> Sorted? {
        guard let id = Self.id(ofTag: entry["tag"]),
              let channel = entry["channel"]?.stringValue,
              let title = entry["title"]?.stringValue,
              let postedAt = finite(entry["postedAt"])
        else { return nil }
        var fields: [String: JSONValue] = [
            "id": .string(id),
            "channel": .string(channel),
            "title": .string(title),
            "ongoing": .bool(entry["ongoing"]?.boolValue == true),
            "actions": .array(actions(entry["actions"])),
            "postedAt": .number(postedAt),
        ]
        if let body = entry["body"]?.stringValue { fields["body"] = .string(body) }
        if let group = entry["group"]?.stringValue { fields["group"] = .string(group) }
        if let progress = Self.progress(entry["progress"]) { fields["progress"] = progress }
        return Sorted(id: id, time: postedAt, json: .object(fields))
    }

    private static func pending(_ entry: [String: JSONValue]) -> Sorted? {
        guard let id = Self.id(ofTag: entry["tag"]), let fireAt = finite(entry["fireAt"]) else { return nil }
        return Sorted(id: id, time: fireAt, json: .object(["id": .string(id), "fireAt": .number(fireAt)]))
    }

    private static func actions(_ value: JSONValue?) -> [JSONValue] {
        guard case let .array(items)? = value else { return [] }
        return items.filter { $0.stringValue != nil }
    }

    private static func progress(_ value: JSONValue?) -> JSONValue? {
        guard let progress = value?.objectFields else { return nil }
        if let fraction = finite(progress["value"]), (0 ... 1).contains(fraction) {
            return .object(["value": .number(fraction)])
        }
        return progress["indeterminate"]?.boolValue == true ? .object(["indeterminate": .bool(true)]) : nil
    }

    private static func entries(_ value: JSONValue?) -> [[String: JSONValue]] {
        guard case let .array(items)? = value else { return [] }
        return items.compactMap(\.objectFields)
    }

    private static func finite(_ value: JSONValue?) -> Double? {
        guard let number = value?.numberValue, number.isFinite else { return nil }
        return number
    }
}
