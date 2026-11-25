import Foundation

/// What a runtime reports and posts for one simulated push (#14285), the Swift twin of TypeScript's
/// `prototypePushDelivery` (`prototypePushDelivery.ts`). All three replay
/// `test/fixtures/prototype-spec/push/traces.json`. `notification` is the system route's delivery; on
/// the connection route an active app is `foreground` and any other app state is `background`. A push
/// no handler takes posts its `notification`, if it has one, as a plain alert.
enum PrototypePushDelivery {
    static let event = "notifications.push"

    /// How the push reached the runtime: the live connection frame or the system push path.
    enum Route: Equatable {
        case connection
        case system
    }

    /// `event` is the `prototype_platform_event` payload; `alert` is nil when none is posted.
    struct Outcome: Equatable {
        let event: JSONValue
        let alert: JSONValue?
    }

    private static let alertFields = ["title", "body", "channel", "group", "badge"]

    /// `handled` is whether the spec has a `notifications.push` handler; `payload` is a push the host
    /// already validated; `appState` uses the `platformRuntime.appState` vocabulary.
    static func deliver(handled: Bool, payload: [String: JSONValue], appState: String, route: Route) -> Outcome {
        let event = JSONValue.object([
            "event": .string(Self.event),
            "data": .object([
                "type": payload["type"] ?? .null,
                "delivery": .string(delivery(route: route, appState: appState)),
                "handled": .bool(handled),
            ]),
            "simulated": .bool(true),
        ])
        guard !handled, let notification = payload["notification"]?.objectFields else {
            return Outcome(event: event, alert: nil)
        }
        let alert = notification.filter { alertFields.contains($0.key) }
        return Outcome(event: event, alert: .object(alert))
    }

    /// The `delivery` wire value for `route` while the app is in `appState`.
    static func delivery(route: Route, appState: String) -> String {
        if route == .system { return "notification" }
        return appState == "active" ? "foreground" : "background"
    }
}
