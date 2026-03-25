import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif

/// Notification style for test notifications.
public enum NotificationStyle: String, Sendable {
    case `default`
    case bigText
    case bigPicture
}

/// An action button attached to a notification.
public struct NotificationAction: Sendable {
    public let label: String
    public let actionId: String

    public init(label: String, actionId: String) {
        self.label = label
        self.actionId = actionId
    }
}

/// Post local notifications for testing.
/// iOS equivalent of Android's AutoMobileNotifications.
public final class AutoMobileNotifications: @unchecked Sendable {
    public static let shared = AutoMobileNotifications()

    /// Category identifier used for notifications with actions.
    public static let categoryIdentifier = "dev.jasonpearson.automobile.sdk.NOTIFICATION"

    /// Notification posted when a notification action is tapped.
    public static let actionNotification = Notification.Name(
        "dev.jasonpearson.automobile.sdk.NOTIFICATION_ACTION"
    )

    private init() {}

    /// Post a local notification.
    /// Returns true if the notification was scheduled successfully.
    #if canImport(UserNotifications)
    public func post(
        title: String,
        body: String,
        style: NotificationStyle = .default,
        imagePath: String? = nil,
        actions: [NotificationAction] = [],
        categoryId: String? = nil
    ) async -> Bool {
        let center = UNUserNotificationCenter.current()

        // Request authorization if needed
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        // Handle image attachment
        if let imagePath = imagePath, let url = imageURL(from: imagePath) {
            if let attachment = try? UNNotificationAttachment(identifier: "image", url: url) {
                content.attachments = [attachment]
            }
        }

        // Register actions if provided
        if !actions.isEmpty {
            let category = categoryId ?? Self.categoryIdentifier
            let unActions = actions.map { action in
                UNNotificationAction(
                    identifier: action.actionId,
                    title: action.label,
                    options: .foreground
                )
            }
            let notificationCategory = UNNotificationCategory(
                identifier: category,
                actions: unActions,
                intentIdentifiers: []
            )
            center.setNotificationCategories([notificationCategory])
            content.categoryIdentifier = category
        }

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        )

        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }

    private func imageURL(from path: String) -> URL? {
        if path.hasPrefix("http://") || path.hasPrefix("https://") {
            return URL(string: path)
        }
        let url = URL(fileURLWithPath: path)
        return FileManager.default.fileExists(atPath: path) ? url : nil
    }
    #endif
}
