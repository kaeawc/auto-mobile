import Foundation

struct PrototypeNotificationAction: Codable, Equatable, Sendable {
    let id: String
    let label: String
    let opensApp: Bool
    /// A non-nil placeholder, including the empty string, denotes a text-input action.
    let replyPlaceholder: String?
}

struct PrototypeNotificationRequest: Sendable {
    let identifier: String
    let prototypeId: String
    let notificationId: String
    let title: String
    let body: String
    let group: String
    let badge: Int?
    let passive: Bool
    let silent: Bool
    let delaySeconds: Int?
    let actions: [PrototypeNotificationAction]
    let data: JSONValue

    var categoryIdentifier: String? {
        guard !actions.isEmpty else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let bytes = try? encoder.encode(actions) else { return nil }
        let hash = bytes.reduce(UInt64(0xCBF2_9CE4_8422_2325)) { ($0 ^ UInt64($1)) &* 0x100_0000_01B3 }
        return "proto:" + String(hash, radix: 16)
    }
}

struct PrototypeNotificationEntry: Sendable {
    let identifier: String
    let group: String
    let prototypeId: String
}

struct PrototypeNotificationSnapshot: Sendable {
    var authorization: PrototypePermissionState = .unavailable
    var blockedChannels: Set<String> = []
    var deliveryDisabled = false
    var badge = 0
    var delivered: [PrototypeNotificationEntry] = []
    var pending: [PrototypeNotificationEntry] = []
}

struct PrototypeNotificationResponse: Sendable {
    let prototypeId: String
    let notificationId: String
    let actionId: String?
    let reply: String?
    let data: JSONValue
}

@MainActor
protocol NotificationCenterClient: AnyObject {
    var onResponse: ((PrototypeNotificationResponse) -> Void)? { get set }
    var onChange: (() -> Void)? { get set }
    func snapshot() async -> PrototypeNotificationSnapshot
    func add(_ request: PrototypeNotificationRequest) async throws
    func remove(delivered: [String], pending: [String])
    func setBadge(_ count: Int) async throws
    /// Registers the category alongside existing categories for earlier notifications.
    func setCategory(_ identifier: String, actions: [PrototypeNotificationAction]) async
}

@MainActor
final class PrototypeNotificationsModule: PrototypePlatformModule {
    let name = "notifications"
    let capability = "prototype_platform_notifications_v1"
    /// Gates `notifications.schedule` (`delaySeconds`) in the contract; advertised beside `capability`.
    static let scheduledCapability = "prototype_platform_notifications_scheduled_v1"
    var capabilities: [String] { [capability, Self.scheduledCapability] }
    private let client: any NotificationCenterClient
    private let clock: any PrototypeMonotonicClock
    private var prototypeId: String?
    private var channels: [String: String] = [:]
    private var snapshot = PrototypeNotificationSnapshot()
    private var operation: (id: UUID, task: Task<PlatformCallResult, Never>)?
    private var refreshTask: Task<Void, Never>?
    private var refreshRequested = false
    private var queue = PrototypeOfflineEventBuffer<PrototypeNotificationResponse>(capacity: 64)
    private var subscribers: [UUID: AsyncStream<PlatformEvent>.Continuation] = [:]
    private var updates: [String: [Int]] = [:]

    init(client: any NotificationCenterClient, clock: any PrototypeMonotonicClock = SystemPrototypeClock()) {
        self.client = client
        self.clock = clock
        client.onResponse = { [weak self] response in self?.receive(response) }
        client.onChange = { [weak self] in self?.refresh() }
    }

    func configure(prototypeId: String?, block: JSONValue?) {
        if self.prototypeId != prototypeId {
            subscribers.values.forEach { $0.finish() }
            subscribers.removeAll()
        }
        self.prototypeId = prototypeId
        channels.removeAll()
        if case let .array(entries)? = block?.objectFields?["channels"] {
            for entry in entries {
                guard let id = entry.objectFields?["id"]?.stringValue else { continue }
                channels[id] = entry.objectFields?["importance"]?.stringValue ?? "default"
            }
        }
    }

    func availability() -> PlatformAvailability { .ready }

    var state: [String: JSONValue] {
        let active = snapshot.delivered.filter(owns).count
        let pending = snapshot.pending.filter(owns).count
        return [
            "authorization": .string(snapshot.authorization.rawValue),
            "badge": .number(Double(snapshot.badge)),
            "active": .number(Double(min(active, Self.maxActive))),
            "pending": .number(Double(min(pending, Self.maxPending))),
            "channels": .object(Dictionary(uniqueKeysWithValues: channels.keys.map {
                ($0, .object(["blocked": .bool(blocked($0))]))
            })),
        ]
    }

    var events: AsyncStream<PlatformEvent> {
        let (stream, continuation) = AsyncStream.makeStream(
            of: PlatformEvent.self, bufferingPolicy: .bufferingNewest(64)
        )
        let id = UUID()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.subscribers[id] = nil }
        }
        if let prototypeId {
            for response in queue.drain() where response.prototypeId == prototypeId {
                continuation.yield(event(for: response))
            }
        }
        refresh()
        return stream
    }

    func stop() {
        refreshTask?.cancel()
        refreshTask = nil
        refreshRequested = false
        configure(prototypeId: nil, block: nil)
    }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        if let invalid = PrototypePlatformDriver.invalidArguments(call) { return invalid }
        guard let prototypeId else { return .failure(.unavailable, "No prototype is shown") }
        // The driver bounds in-flight calls. Keep each read/modify/write of the system
        // inventory ordered, including multiple operations authored on one gesture.
        let previous = operation?.task
        let id = UUID()
        let task = Task {
            if let previous { _ = await previous.value }
            return await perform(call, prototypeId: prototypeId)
        }
        operation = (id, task)
        return await withTaskCancellationHandler {
            let result = await task.value
            if operation?.id == id {
                operation = nil
                if refreshRequested { refresh() }
            }
            return result
        } onCancel: {
            task.cancel()
        }
    }

    private func perform(_ call: PlatformCall, prototypeId: String) async -> PlatformCallResult {
        guard prototypeId == self.prototypeId, !Task.isCancelled else {
            return .failure(.cancelled, "Notification call cancelled")
        }
        // Prevent an older asynchronous refresh from overwriting this serialized mutation.
        refreshTask?.cancel()
        refreshTask = nil
        let current = await client.snapshot()
        guard prototypeId == self.prototypeId, !Task.isCancelled else {
            return .failure(.cancelled, "Notification call cancelled")
        }
        snapshot = current
        if call.call == "notifications.cancel" { return cancel(call.args) }
        if let failure = authorizationFailure(snapshot.authorization) { return failure }
        do {
            if call.call == "notifications.setBadge", let count = call.args["count"]?.intValue {
                try await client.setBadge(count)
                snapshot.badge = count
                return .success(.object([:]))
            }
            return try await post(call.args, prototypeId: prototypeId)
        } catch {
            let current = await client.snapshot()
            snapshot = current
            if current.authorization == .denied {
                return .failure(.permissionDenied, "Notification permission is required")
            }
            return .failure(.platformError, "Notification center rejected the request")
        }
    }

    private func authorizationFailure(_ authorization: PrototypePermissionState) -> PlatformCallResult? {
        switch authorization {
        case .granted, .limited: nil
        case .unavailable: .failure(.unavailable, "Notification center is unavailable")
        default: .failure(.permissionDenied, "Notification permission is required")
        }
    }

    private static let maxActive = PrototypeContractValidator.limit("MAX_PROTOTYPE_NOTIFICATIONS_ACTIVE")
    private static let maxPending = 64

    private func owns(_ entry: PrototypeNotificationEntry) -> Bool {
        entry.prototypeId == prototypeId
    }

    private static func prefix(_ prototypeId: String) -> String {
        // Escape the namespace separator so a notification id containing ":" cannot alias another prototype.
        let escapedId = prototypeId.replacingOccurrences(of: "%", with: "%25")
            .replacingOccurrences(of: ":", with: "%3A")
        return PrototypeNotificationsReport.tagPrefix + escapedId + ":"
    }

    private func blocked(_ channel: String) -> Bool {
        snapshot.deliveryDisabled || snapshot.blockedChannels.contains(channel)
    }

    private func cancel(_ args: [String: JSONValue]) -> PlatformCallResult {
        guard ["id", "group", "all"].count(where: { args[$0] != nil }) == 1 else {
            return .failure(.invalidArgs, "Choose exactly one notification id, group or all")
        }
        let matches: (PrototypeNotificationEntry) -> Bool = { entry in
            guard self.owns(entry) else { return false }
            if let id = args["id"]?.stringValue, let prototypeId = self.prototypeId {
                return entry.identifier == Self.prefix(prototypeId) + id
            }
            if let group = args["group"]?.stringValue { return entry.group == group }
            return true
        }
        if let id = args["id"]?.stringValue, let prototypeId {
            let identifier = Self.prefix(prototypeId) + id
            client.remove(delivered: [identifier], pending: [identifier])
        } else {
            client.remove(
                delivered: snapshot.delivered.filter(matches).map(\.identifier),
                pending: snapshot.pending.filter(matches).map(\.identifier)
            )
        }
        snapshot.delivered.removeAll(where: matches)
        snapshot.pending.removeAll(where: matches)
        return .success(.object([:]))
    }

    private func post(_ args: [String: JSONValue], prototypeId: String) async throws -> PlatformCallResult {
        guard let id = args["id"]?.stringValue, let title = args["title"]?.stringValue,
              let channel = args["channel"]?.stringValue, let importance = channels[channel]
        else { return .failure(.invalidArgs, "A declared notification channel, id and title are required") }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let maxBytes = PrototypeContractValidator.limit("MAX_PROTOTYPE_NOTIFICATION_BYTES")
        guard let encoded = try? encoder.encode(args), encoded.count <= maxBytes else {
            return .failure(.invalidArgs, "Resolved notification exceeds the size limit")
        }
        let actions = Self.actions(args["actions"])
        guard Set(actions.map(\.id)).count == actions.count else {
            return .failure(.invalidArgs, "Duplicate notification action id")
        }
        guard !blocked(channel) else { return .failure(.unavailable, "Notification channel is blocked") }
        let request = PrototypeNotificationRequest(
            identifier: Self.prefix(prototypeId) + id, prototypeId: prototypeId, notificationId: id,
            title: title, body: args["body"]?.stringValue ?? "", group: args["group"]?.stringValue ?? "",
            badge: args["badge"]?.intValue, passive: importance == "min" || importance == "low",
            silent: args["silent"]?.boolValue == true, delaySeconds: args["delaySeconds"]?.intValue,
            actions: actions, data: args["data"] ?? .null
        )
        return try await submit(request)
    }

    private func submit(_ request: PrototypeNotificationRequest) async throws -> PlatformCallResult {
        let scheduled = request.delaySeconds != nil
        // iOS can fire pending notifications while the Viewer is suspended. Each distinct
        // pending id reserves space so an OS delivery cannot exceed the active budget.
        let occupied = Set((snapshot.delivered + snapshot.pending).filter(owns).map(\.identifier))
        guard occupied.contains(request.identifier) || occupied.count < Self.maxActive else {
            return .failure(.tooManyInFlight, "Notification limit reached")
        }
        let now = clock.monotonicMilliseconds
        updates = updates.compactMapValues { times in
            let recent = times.filter { now - $0 < 1000 }
            return recent.isEmpty ? nil : recent
        }
        let maxUpdates = PrototypeContractValidator.limit("MAX_PROTOTYPE_NOTIFICATION_UPDATES_PER_SECOND")
        guard updates[request.identifier, default: []].count < maxUpdates else {
            return .failure(.tooManyInFlight, "Notification update limit reached")
        }
        if let category = request.categoryIdentifier {
            await client.setCategory(category, actions: request.actions)
        }
        guard request.prototypeId == prototypeId, !Task.isCancelled else {
            return .failure(.cancelled, "Notification call cancelled")
        }
        try await client.add(request)
        updates[request.identifier, default: []].append(now)
        let entry = PrototypeNotificationEntry(
            identifier: request.identifier, group: request.group, prototypeId: request.prototypeId
        )
        snapshot.pending.removeAll { $0.identifier == request.identifier }
        if scheduled {
            snapshot.pending.append(entry)
        } else {
            snapshot.delivered.removeAll { $0.identifier == request.identifier }
            snapshot.delivered.append(entry)
            if let badge = request.badge { snapshot.badge = badge }
        }
        return .success(.object([:]))
    }

    private static func actions(_ value: JSONValue?) -> [PrototypeNotificationAction] {
        guard case let .array(entries)? = value else { return [] }
        return entries.compactMap { entry in
            guard let fields = entry.objectFields,
                  let id = fields["id"]?.stringValue, let label = fields["label"]?.stringValue else { return nil }
            return PrototypeNotificationAction(
                id: id, label: label, opensApp: fields["opensApp"]?.boolValue ?? true,
                replyPlaceholder: fields["reply"]?.objectFields.map { $0["placeholder"]?.stringValue ?? "" }
            )
        }
    }

    private func receive(_ response: PrototypeNotificationResponse) {
        guard let prototypeId, !subscribers.isEmpty else {
            queue.add(response)
            return
        }
        guard response.prototypeId == prototypeId else { return }
        subscribers.values.forEach { $0.yield(event(for: response)) }
    }

    private func event(for response: PrototypeNotificationResponse) -> PlatformEvent {
        var fields: [String: JSONValue] = [
            "notificationId": .string(response.notificationId),
            "data": response.data,
        ]
        if let action = response.actionId { fields["actionId"] = .string(action) }
        if let reply = response.reply {
            let limit = PrototypeContractValidator.limit("MAX_PROTOTYPE_NOTIFICATION_REPLY_BYTES")
            // Keep complete Unicode scalars at the UTF-8 boundary.
            var text = String.UnicodeScalarView()
            var bytes = 0
            for scalar in reply.unicodeScalars {
                let size = String(scalar).utf8.count
                guard bytes + size <= limit else { break }
                text.append(scalar)
                bytes += size
            }
            fields["reply"] = .string(String(text))
        }
        let event = response.reply != nil ? "reply" : response.actionId == nil ? "opened" : "action"
        return PlatformEvent(event: "notifications." + event, data: .object(fields))
    }

    private func refresh() {
        guard !subscribers.isEmpty else { return }
        refreshRequested = true
        guard operation == nil, refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            while refreshRequested, !Task.isCancelled {
                refreshRequested = false
                let current = await client.snapshot()
                guard !Task.isCancelled else { return }
                snapshot = current
                subscribers.values.forEach { $0.yield(.stateRefresh(name)) }
            }
            if !Task.isCancelled { refreshTask = nil }
        }
    }
}
