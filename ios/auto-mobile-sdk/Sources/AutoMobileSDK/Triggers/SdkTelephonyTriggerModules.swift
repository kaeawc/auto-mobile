#if DEBUG && !os(watchOS)
    import Foundation
    import os
    #if canImport(CallKit) && os(iOS)
        import CallKit
    #endif

    // Host-triggered telephony for iOS (#1580). The host's `phoneCall` and `sendSms` tools use the
    // Android emulator console on Android; on iOS they reach these modules through `POST /trigger`.
    // Trigger names match the tools' arguments so the host maps them one to one.

    /// How a simulated call ended, mirroring the Android `gsm cancel` / `gsm busy` console commands.
    enum SdkCallEndReason: Equatable, Sendable {
        /// The remote party hung up (`cancel`).
        case remoteEnded
        /// The remote party was busy or declined (`busy`).
        case unanswered
    }

    /// The CallKit operations the call module drives. Each returns nil on success or a short
    /// failure reason that the trigger route returns to the host. Keeping this narrow lets the
    /// module's bookkeeping run in host unit tests, where CallKit is unavailable.
    protocol SdkCallReporting: Sendable {
        func reportIncomingCall(id: UUID, phoneNumber: String) -> String?
        func answerCall(id: UUID) -> String?
        func endCall(id: UUID, reason: SdkCallEndReason) -> String?
        func holdCall(id: UUID) -> String?
    }

    /// `callkit` trigger module: `call`, `accept`, `cancel`, `busy` and `hold`, with the same
    /// `phoneNumber` payload field as the host `phoneCall` tool. `hold` needs no number and holds
    /// the most recent call.
    final class SdkCallKitTriggerModule: SdkTriggerModule {
        static let moduleName = "callkit"

        private struct State {
            var callsByNumber: [String: UUID] = [:]
            var mostRecent: UUID?
        }

        private let reporter: any SdkCallReporting
        private let makeId: @Sendable () -> UUID
        private let state = OSAllocatedUnfairLock(initialState: State())

        init(reporter: any SdkCallReporting, makeId: @escaping @Sendable () -> UUID = { UUID() }) {
            self.reporter = reporter
            self.makeId = makeId
        }

        var triggers: [String] {
            ["call", "accept", "cancel", "busy", "hold"]
        }

        func handle(trigger: String, payload: [String: Any]) -> SdkTriggerOutcome {
            guard triggers.contains(trigger) else { return .unknownTrigger }
            if trigger == "hold" {
                guard let id = state.withLock({ $0.mostRecent }) else { return .failed("no_active_call") }
                return outcome(reporter.holdCall(id: id))
            }
            guard let phoneNumber = payload["phoneNumber"] as? String, !phoneNumber.isEmpty else {
                return .invalidPayload("missing_phone_number")
            }
            if trigger == "call" {
                return reportIncoming(phoneNumber)
            }
            guard let id = state.withLock({ $0.callsByNumber[phoneNumber] }) else {
                return .failed("no_call_for_number")
            }
            switch trigger {
            case "accept":
                return outcome(reporter.answerCall(id: id))
            case "cancel":
                return end(id: id, phoneNumber: phoneNumber, reason: .remoteEnded)
            default:
                return end(id: id, phoneNumber: phoneNumber, reason: .unanswered)
            }
        }

        private func reportIncoming(_ phoneNumber: String) -> SdkTriggerOutcome {
            let id = makeId()
            if let failure = reporter.reportIncomingCall(id: id, phoneNumber: phoneNumber) {
                return .failed(failure)
            }
            state.withLock {
                $0.callsByNumber[phoneNumber] = id
                $0.mostRecent = id
            }
            return .handled
        }

        private func end(id: UUID, phoneNumber: String, reason: SdkCallEndReason) -> SdkTriggerOutcome {
            if let failure = reporter.endCall(id: id, reason: reason) {
                return .failed(failure)
            }
            state.withLock {
                $0.callsByNumber.removeValue(forKey: phoneNumber)
                if $0.mostRecent == id {
                    $0.mostRecent = nil
                }
            }
            return .handled
        }

        private func outcome(_ failure: String?) -> SdkTriggerOutcome {
            failure.map { .failed($0) } ?? .handled
        }
    }

    /// `messages` trigger module: `sms` posts an SMS-style local notification titled with the
    /// sender's number, with the same `phoneNumber` and `message` fields as the host `sendSms` tool.
    /// Delivery is asynchronous: `handled` means the notification was handed to the system.
    struct SdkMessagesTriggerModule: SdkTriggerModule {
        static let moduleName = "messages"

        private let post: @Sendable (_ title: String, _ body: String) -> Void

        init(post: @escaping @Sendable (_ title: String, _ body: String) -> Void = Self.postLocalNotification) {
            self.post = post
        }

        var triggers: [String] {
            ["sms"]
        }

        func handle(trigger: String, payload: [String: Any]) -> SdkTriggerOutcome {
            guard trigger == "sms" else { return .unknownTrigger }
            guard let phoneNumber = payload["phoneNumber"] as? String, !phoneNumber.isEmpty else {
                return .invalidPayload("missing_phone_number")
            }
            guard let message = payload["message"] as? String else {
                return .invalidPayload("missing_message")
            }
            post(phoneNumber, message)
            return .handled
        }

        // `@Sendable` so the default `post` argument converts without a data-race warning; the
        // body only captures its `String` parameters into a `Task`.
        @Sendable
        static func postLocalNotification(title: String, body: String) {
            #if canImport(UserNotifications)
                Task {
                    let posted = await AutoMobileNotifications.shared.post(title: title, body: body)
                    if !posted {
                        InternalLogger.warning("[AutoMobileSDK] SMS trigger notification was not scheduled")
                    }
                }
            #endif
        }
    }

    #if canImport(CallKit) && os(iOS)
        /// Real CallKit reporter. The provider is created on first use so apps that never receive
        /// a call trigger never register one. Completions are awaited for at most
        /// `completionTimeout` because the runner's request to the SDK times out after 2 seconds.
        final class CallKitSdkCallReporter: NSObject, SdkCallReporting, CXProviderDelegate, @unchecked Sendable {
            static let completionTimeout: DispatchTimeInterval = .milliseconds(1500)

            private let queue = DispatchQueue(label: "dev.jasonpearson.automobile.sdk.callkit")
            private let lock = NSLock()
            private var provider: CXProvider?
            private let controller = CXCallController()

            func reportIncomingCall(id: UUID, phoneNumber: String) -> String? {
                let update = CXCallUpdate()
                update.remoteHandle = CXHandle(type: .phoneNumber, value: phoneNumber)
                update.localizedCallerName = phoneNumber
                update.hasVideo = false
                update.supportsHolding = true
                let provider = resolvedProvider()
                return waitForCompletion { done in
                    provider.reportNewIncomingCall(with: id, update: update) { done($0) }
                }
            }

            func answerCall(id: UUID) -> String? {
                request(CXAnswerCallAction(call: id))
            }

            func endCall(id: UUID, reason: SdkCallEndReason) -> String? {
                let endedReason: CXCallEndedReason = switch reason {
                case .remoteEnded: .remoteEnded
                case .unanswered: .unanswered
                }
                resolvedProvider().reportCall(with: id, endedAt: Date(), reason: endedReason)
                return nil
            }

            func holdCall(id: UUID) -> String? {
                request(CXSetHeldCallAction(call: id, onHold: true))
            }

            // MARK: - CXProviderDelegate

            func providerDidReset(_: CXProvider) {}

            func provider(_: CXProvider, perform action: CXAnswerCallAction) {
                action.fulfill()
            }

            func provider(_: CXProvider, perform action: CXEndCallAction) {
                action.fulfill()
            }

            func provider(_: CXProvider, perform action: CXSetHeldCallAction) {
                action.fulfill()
            }

            // MARK: - Private

            private func resolvedProvider() -> CXProvider {
                lock.lock()
                defer { lock.unlock() }
                if let provider {
                    return provider
                }
                let configuration = CXProviderConfiguration()
                configuration.supportsVideo = false
                configuration.maximumCallGroups = 1
                configuration.maximumCallsPerCallGroup = 1
                configuration.supportedHandleTypes = [.phoneNumber]
                let created = CXProvider(configuration: configuration)
                created.setDelegate(self, queue: queue)
                provider = created
                return created
            }

            private func request(_ action: CXCallAction) -> String? {
                _ = resolvedProvider()
                return waitForCompletion { done in
                    self.controller.request(CXTransaction(action: action)) { done($0) }
                }
            }

            private func waitForCompletion(_ start: (@escaping @Sendable (Error?) -> Void) -> Void) -> String? {
                let semaphore = DispatchSemaphore(value: 0)
                let failure = OSAllocatedUnfairLock<String?>(initialState: nil)
                start { error in
                    if let error {
                        failure.withLock { $0 = "callkit_error: \(error.localizedDescription)" }
                    }
                    semaphore.signal()
                }
                guard semaphore.wait(timeout: .now() + Self.completionTimeout) == .success else {
                    return "callkit_timeout"
                }
                return failure.withLock { $0 }
            }
        }
    #endif
#endif
