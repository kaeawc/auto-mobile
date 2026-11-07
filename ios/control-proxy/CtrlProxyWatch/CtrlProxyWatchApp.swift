import SwiftUI
import UserNotifications

@main
struct CtrlProxyWatchApp: App {
    @State private var crown = 0.0
    @State private var text = ""
    private enum CrownFocus: Hashable {
        case fixture, list
    }

    @FocusState private var crownFocus: CrownFocus?
    @StateObject private var notifications = WatchNotificationFixture()

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                VStack {
                    crownFixture
                        .frame(height: 95)
                    Text(notifications.status)
                        .accessibilityIdentifier("watch-notification-status")
                    List {
                        NavigationLink {
                            Text("Watch smoke next")
                                .accessibilityIdentifier("watch-smoke-next")
                        } label: {
                            Text("watch-smoke-row")
                        }
                        .accessibilityIdentifier("watch-smoke-row")
                        NavigationLink {
                            VStack {
                                TextField("Text", text: $text)
                                    .accessibilityIdentifier("watch-text-field")
                                Text(text)
                                    .accessibilityIdentifier("watch-text-value")
                            }
                        } label: {
                            Text("Text entry")
                        }
                        .accessibilityIdentifier("watch-text-entry")
                        ForEach(1 ... 30, id: \.self) { row in
                            Text("Scroll row \(row)")
                                .accessibilityIdentifier("watch-scroll-row-\(row)")
                                .onTapGesture { crownFocus = .list }
                        }
                    }
                    // Native List crown scrolling is active when focus leaves the value fixture.
                    .focusable()
                    .focused($crownFocus, equals: .list)
                }
            }
        }
    }

    private var crownFixture: some View {
        ZStack {
            Text("CtrlProxy Watch")
                .accessibilityIdentifier("ctrlproxy-crown")
                .focusable()
                .focused($crownFocus, equals: .fixture)
                .digitalCrownRotation(
                    $crown, from: -1000, through: 1000, by: 0.1,
                    sensitivity: .high, isContinuous: true, isHapticFeedbackEnabled: false
                )
                .onAppear { crownFocus = .fixture }
                .onTapGesture { crownFocus = .fixture }
            Text("crown \(crown, format: .number.precision(.fractionLength(2)))")
                .accessibilityIdentifier("ctrlproxy-crown-value")
                .offset(y: 40)
            Color.clear
                .frame(width: 0, height: 0)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Non-hittable fixture")
                .accessibilityIdentifier("ctrlproxy-non-hittable")
        }
    }
}

/// Notification fixture: requests authorization, registers category AM_WATCH_CHECK with two actions
/// and records the chosen action so a push can be verified end to end.
@MainActor
final class WatchNotificationFixture: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published var status = UserDefaults.standard.string(forKey: "notificationStatus") ?? "notification idle"

    private func record(_ text: String) {
        status = text
        UserDefaults.standard.set(text, forKey: "notificationStatus")
    }

    override init() {
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let accept = UNNotificationAction(identifier: "ACCEPT_ACTION", title: "Accept", options: [])
        let decline = UNNotificationAction(identifier: "DECLINE_ACTION", title: "Decline", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: "AM_WATCH_CHECK", actions: [accept, decline], intentIdentifiers: [], options: []
            ),
        ])
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                let state = settings.authorizationStatus == .authorized ? "authorized" : "not authorized"
                Task { @MainActor in
                    if !self.status.hasPrefix("notification action") { self.record("notification \(state)") }
                }
            }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let action = response.actionIdentifier
        await MainActor.run { self.record("notification action \(action)") }
    }
}
