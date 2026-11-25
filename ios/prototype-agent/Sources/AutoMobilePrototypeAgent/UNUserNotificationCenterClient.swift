#if canImport(UIKit) && canImport(UserNotifications)
    import UIKit
    import UserNotifications

    @MainActor
    final class UNUserNotificationCenterClient: NSObject, NotificationCenterClient, UNUserNotificationCenterDelegate {
        var onResponse: ((PrototypeNotificationResponse) -> Void)?
        var onChange: (() -> Void)?
        private static let recordsKey = "PrototypeNotificationRecords"
        private static let badgeKey = "PrototypeNotificationBadge"
        private static let badgeDateKey = "PrototypeNotificationBadgeDate"

        private struct Record: Codable {
            let identifier: String
            let data: JSONValue
        }

        private var records: [Record] = []
        /// Keep records for live requests even when other notifications are updated repeatedly.
        private var liveRecords: Set<String> = []

        private var center: UNUserNotificationCenter? {
            guard PrototypeNotificationAuthorization.canAccessCenter(
                bundlePath: Bundle.main.bundlePath, bundleIdentifier: Bundle.main.bundleIdentifier
            ) else { return nil }
            return .current()
        }

        func installDelegate() {
            guard let center else { return }
            if let encoded = UserDefaults.standard.data(forKey: Self.recordsKey) {
                records = (try? JSONDecoder().decode([Record].self, from: encoded)) ?? []
            }
            center.delegate = self
            NotificationCenter.default.addObserver(
                self, selector: #selector(becameActive(_:)),
                name: UIApplication.didBecomeActiveNotification, object: nil
            )
        }

        func snapshot() async -> PrototypeNotificationSnapshot {
            guard let center else { return PrototypeNotificationSnapshot() }
            let settings = await center.notificationSettings()
            let authorization = UNUserNotificationCenterPrototypePermissionsSource
                .authorization(settings.authorizationStatus).state
            let notifications = await center.deliveredNotifications()
            if let latest = notifications.filter({ $0.request.content.badge != nil }).max(by: { $0.date < $1.date }),
               let badge = latest.request.content.badge?.intValue
            {
                Self.recordBadge(badge, date: latest.date)
            }
            let delivered = notifications.map(\.request)
            let pending = await center.pendingNotificationRequests()
            liveRecords = Set((delivered + pending).compactMap { $0.content.userInfo["recordId"] as? String })
            let deliveryDisabled = settings.alertSetting == .disabled
                && settings.notificationCenterSetting == .disabled && settings.lockScreenSetting == .disabled
            return PrototypeNotificationSnapshot(
                authorization: authorization, deliveryDisabled: deliveryDisabled,
                badge: UserDefaults.standard.integer(forKey: Self.badgeKey),
                delivered: notifications.compactMap { Self.entry($0.request, postedAt: $0.date) },
                pending: pending.compactMap { Self.entry($0, fireAt: Self.fireDate(of: $0)) }
            )
        }

        func add(_ request: PrototypeNotificationRequest) async throws {
            guard let center else { throw CocoaError(.featureUnsupported) }
            let content = UNMutableNotificationContent()
            content.title = request.title
            content.body = request.body
            content.threadIdentifier = request.group
            content.badge = request.badge.map { NSNumber(value: $0) }
            content.interruptionLevel = request.passive ? .passive : .active
            content.sound = request.silent ? nil : .default
            content.categoryIdentifier = request.categoryIdentifier ?? ""
            // Keep resolved event data in the Viewer container. The OS request carries identifiers only.
            let record = Record(identifier: UUID().uuidString, data: request.data)
            var userInfo: [AnyHashable: Any] = [
                "prototypeId": request.prototypeId, "notificationId": request.notificationId,
                "recordId": record.identifier, "channel": request.channel, "actions": request.actions.map(\.id),
            ]
            // A time-interval trigger's nextTriggerDate() counts from the read, so keep the scheduled time.
            if let delay = request.delaySeconds {
                userInfo["fireAt"] = Date().addingTimeInterval(TimeInterval(delay)).timeIntervalSince1970
            }
            content.userInfo = userInfo
            records.append(record)
            persistRecords()
            let trigger = request.delaySeconds.map {
                UNTimeIntervalNotificationTrigger(timeInterval: TimeInterval($0), repeats: false)
            }
            do {
                try await center.add(UNNotificationRequest(
                    identifier: request.identifier, content: content, trigger: trigger
                ))
            } catch {
                records.removeAll { $0.identifier == record.identifier }
                persistRecords()
                throw error
            }
        }

        func remove(delivered: [String], pending: [String]) {
            guard let center else { return }
            if !pending.isEmpty { center.removePendingNotificationRequests(withIdentifiers: pending) }
            if !delivered.isEmpty { center.removeDeliveredNotifications(withIdentifiers: delivered) }
        }

        func setBadge(_ count: Int) async throws {
            guard let center else { throw CocoaError(.featureUnsupported) }
            try await center.setBadgeCount(count)
            Self.recordBadge(count, date: Date())
        }

        func setCategory(_ identifier: String, actions: [PrototypeNotificationAction]) async {
            guard let center else { return }
            var categories = await center.notificationCategories()
            guard !Task.isCancelled, !categories.contains(where: { $0.identifier == identifier }) else { return }
            let buttons: [UNNotificationAction] = actions.map { action in
                let options: UNNotificationActionOptions = action.opensApp ? [.foreground] : []
                if let placeholder = action.replyPlaceholder {
                    return UNTextInputNotificationAction(
                        identifier: action.id, title: action.label, options: options,
                        textInputButtonTitle: action.label, textInputPlaceholder: placeholder
                    )
                }
                return UNNotificationAction(identifier: action.id, title: action.label, options: options)
            }
            categories.insert(UNNotificationCategory(
                identifier: identifier, actions: buttons, intentIdentifiers: [], options: []
            ))
            center.setNotificationCategories(categories)
        }

        nonisolated func userNotificationCenter(
            _: UNUserNotificationCenter, willPresent notification: UNNotification
        )
            async -> UNNotificationPresentationOptions
        {
            let content = notification.request.content
            guard content.userInfo["recordId"] is String else { return [] }
            let badge = content.badge?.intValue
            let quiet = content.sound == nil
            let passive = content.interruptionLevel == .passive
            let date = notification.date
            await MainActor.run {
                if let badge { Self.recordBadge(badge, date: date) }
                onChange?()
            }
            if quiet { return [.list, .badge] }
            return passive ? [.banner, .list, .badge] : [.banner, .list, .badge, .sound]
        }

        nonisolated func userNotificationCenter(
            _: UNUserNotificationCenter, didReceive response: UNNotificationResponse
        )
            async
        {
            let info = response.notification.request.content.userInfo
            guard let recordId = info["recordId"] as? String,
                  let prototypeId = info["prototypeId"] as? String,
                  let notificationId = info["notificationId"] as? String,
                  response.actionIdentifier != UNNotificationDismissActionIdentifier else { return }
            let action = response.actionIdentifier == UNNotificationDefaultActionIdentifier
                ? nil : response.actionIdentifier
            let reply = (response as? UNTextInputNotificationResponse)?.userText
            let badge = response.notification.request.content.badge?.intValue
            let date = response.notification.date
            await MainActor.run {
                if let badge { Self.recordBadge(badge, date: date) }
                guard let record = records.first(where: { $0.identifier == recordId }) else { return }
                onResponse?(PrototypeNotificationResponse(
                    prototypeId: prototypeId, notificationId: notificationId,
                    actionId: action, reply: reply, data: record.data
                ))
                onChange?()
            }
        }

        @objc
        private func becameActive(_: Notification) { onChange?() }

        private static func recordBadge(_ count: Int, date: Date) {
            let defaults = UserDefaults.standard
            let timestamp = date.timeIntervalSince1970
            guard timestamp >= defaults.double(forKey: badgeDateKey) else { return }
            defaults.set(count, forKey: badgeKey)
            defaults.set(timestamp, forKey: badgeDateKey)
        }

        /// `postedAt` is set for a delivered notification and `fireAt` for a pending request.
        private static func entry(
            _ request: UNNotificationRequest, postedAt: Date? = nil, fireAt: Date? = nil
        )
            -> PrototypeNotificationEntry?
        {
            let content = request.content
            guard let prototypeId = content.userInfo["prototypeId"] as? String else { return nil }
            return PrototypeNotificationEntry(
                identifier: request.identifier, group: content.threadIdentifier, prototypeId: prototypeId,
                notificationId: content.userInfo["notificationId"] as? String,
                channel: content.userInfo["channel"] as? String, title: content.title, body: content.body,
                actions: content.userInfo["actions"] as? [String] ?? [],
                postedAt: postedAt.map(epochMilliseconds), fireAt: fireAt.map(epochMilliseconds)
            )
        }

        private static func fireDate(of request: UNNotificationRequest) -> Date? {
            if let seconds = request.content.userInfo["fireAt"] as? Double {
                return Date(timeIntervalSince1970: seconds)
            }
            return (request.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate()
                ?? (request.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate()
        }

        private static func epochMilliseconds(_ date: Date) -> Double {
            (date.timeIntervalSince1970 * 1000).rounded()
        }

        private func persistRecords() {
            // Keep recent records for responses captured around a replacement or removal.
            let recent = Set(records.suffix(128).map(\.identifier))
            records.removeAll { !liveRecords.contains($0.identifier) && !recent.contains($0.identifier) }
            if let encoded = try? JSONEncoder().encode(records) {
                UserDefaults.standard.set(encoded, forKey: Self.recordsKey)
            }
        }
    }
#endif
