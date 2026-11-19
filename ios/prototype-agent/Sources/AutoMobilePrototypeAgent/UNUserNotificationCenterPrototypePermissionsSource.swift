#if canImport(UIKit) && canImport(UserNotifications)
    import UIKit
    import UserNotifications

    @MainActor
    final class UNUserNotificationCenterPrototypePermissionsSource: PrototypeNotificationAuthorizationSource {
        private var observer: (any NSObjectProtocol)?
        private var continuation: AsyncStream<Void>.Continuation?
        private var generation = 0
        private var nextRequest = 0
        private var pending: (id: Int, continuation: CheckedContinuation<PrototypePermissionOutcome, Never>)?

        // Construction never accesses UNUserNotificationCenter, including in a non-app test host.
        private var available: Bool {
            PrototypeNotificationAuthorization.canAccessCenter(
                bundlePath: Bundle.main.bundlePath, bundleIdentifier: Bundle.main.bundleIdentifier
            )
        }

        var changes: AsyncStream<Void> {
            continuation?.finish()
            let (stream, continuation) = AsyncStream.makeStream(
                of: Void.self, bufferingPolicy: .bufferingNewest(8)
            )
            self.continuation = continuation
            observeForeground()
            return stream
        }

        func status() async -> PrototypePermissionState {
            guard available, !Task.isCancelled else { return .unavailable }
            observeForeground()
            let session = generation
            let state = await withCheckedContinuation { continuation in
                UNUserNotificationCenter.current().getNotificationSettings { settings in
                    continuation.resume(returning: Self.authorization(settings.authorizationStatus).state)
                }
            }
            guard !Task.isCancelled, generation == session else { return .unavailable }
            return state
        }

        func request() async -> PrototypePermissionOutcome {
            guard available else { return .status(.unavailable) }
            guard pending == nil else { return .busy }
            let session = generation
            let current = await status()
            guard !Task.isCancelled, session == generation else { return .cancelled }
            guard pending == nil else { return .busy }
            guard current == .notDetermined else { return .status(current) }
            let id = nextRequest
            nextRequest += 1
            return await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    guard !Task.isCancelled else { continuation.resume(returning: .cancelled); return }
                    self.pending = (id, continuation)
                    UNUserNotificationCenter.current().requestAuthorization(
                        options: [.alert, .sound, .badge]
                    ) { [weak self] _, error in
                        let failed = error != nil
                        Task { @MainActor in
                            guard let self, self.pending?.id == id, session == self.generation else { return }
                            if failed { self.finish(id, .platformError); return }
                            // The Bool omits provisional/ephemeral and may be stale. Read settings again.
                            let state = await self.status()
                            guard session == self.generation else { return }
                            self.finish(id, .status(state))
                        }
                    }
                }
            } onCancel: {
                Task { @MainActor [weak self] in self?.finish(id, .cancelled) }
            }
        }

        func stop() {
            generation += 1
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            continuation?.finish()
            continuation = nil
            if let pending { finish(pending.id, .cancelled) }
        }

        private func observeForeground() {
            guard available, observer == nil else { return }
            let session = generation
            observer = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    guard let self, session == self.generation, self.pending == nil else { return }
                    self.continuation?.yield(())
                }
            }
        }

        private func finish(_ id: Int, _ outcome: PrototypePermissionOutcome) {
            guard let pending, pending.id == id else { return }
            self.pending = nil
            pending.continuation.resume(returning: outcome)
        }

        private nonisolated static func authorization(_ status: UNAuthorizationStatus)
            -> PrototypeNotificationAuthorization
        {
            switch status {
            case .notDetermined: .notDetermined
            case .denied: .denied
            case .authorized: .authorized
            case .provisional: .provisional
            case .ephemeral: .ephemeral
            @unknown default: .unknown
            }
        }
    }
#endif
