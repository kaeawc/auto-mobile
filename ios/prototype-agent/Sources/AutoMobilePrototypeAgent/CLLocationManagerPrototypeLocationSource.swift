#if canImport(CoreLocation)
    import CoreLocation
    import Foundation

    extension CLLocationManager: PrototypeLocationStreamActions {
        func setDesiredAccuracy(_ accuracy: Double) { desiredAccuracy = accuracy }
        func startUpdates() { startUpdatingLocation() }
        func stopUpdates() { stopUpdatingLocation() }
    }

    /// Main-actor ownership serializes delegate callbacks and cancellation. Each waiter is removed
    /// before it resumes; a cancelled request cannot be resumed again by a later delegate callback.
    @MainActor
    final class CLLocationManagerPrototypeLocationSource: NSObject, @preconcurrency CLLocationManagerDelegate,
        PrototypeLocationSource
    {
        private let suppliedManager: CLLocationManager?
        // Construction and clearing a callback must not access the host's location manager.
        // Registering a callback creates the delegate, even while Location Services are disabled.
        private lazy var manager: CLLocationManager = {
            let manager = suppliedManager ?? CLLocationManager()
            manager.delegate = self
            return manager
        }()

        private var authorizationWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]
        private var fixWaiters: [UUID: CheckedContinuation<PrototypeLocationFix, any Error>] = [:]
        private var accuracyWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
        private var accuracyRequest: UUID?
        private var streamArbiter = PrototypeLocationStreamArbiter(updateAccuracy: kCLLocationAccuracyBest)
        private var update: (@MainActor @Sendable (PrototypeLocationFix) -> Void)?
        private var authorizationChangeHandler: (@MainActor @Sendable () -> Void)?

        init(manager: CLLocationManager? = nil) {
            suppliedManager = manager
            super.init()
        }

        func setAuthorizationChangeHandler(_ handler: (@MainActor @Sendable () -> Void)?) {
            authorizationChangeHandler = handler
            if handler != nil { _ = manager }
        }

        var servicesEnabled: Bool { CLLocationManager.locationServicesEnabled() }
        var authorization: PrototypeLocationAuthorization {
            switch manager.authorizationStatus {
            case .notDetermined: .notDetermined
            case .denied: .denied
            case .restricted: .restricted
            case .authorizedAlways, .authorizedWhenInUse:
                manager.accuracyAuthorization == .reducedAccuracy ? .authorizedApproximate : .authorizedPrecise
            @unknown default: .restricted
            }
        }

        func requestAuthorization() async {
            let id = UUID()
            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    guard !Task.isCancelled, authorization == .notDetermined else {
                        continuation.resume()
                        return
                    }
                    authorizationWaiters[id] = continuation
                    if authorizationWaiters.count == 1 { manager.requestWhenInUseAuthorization() }
                }
            } onCancel: {
                Task { @MainActor [weak self] in
                    self?.authorizationWaiters.removeValue(forKey: id)?.resume()
                }
            }
        }

        func requestFix(accuracy: String) async throws -> PrototypeLocationFix {
            let id = UUID()
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    guard !Task.isCancelled else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    fixWaiters[id] = continuation
                    let requested = accuracy == "precise" ? kCLLocationAccuracyBest : kCLLocationAccuracyKilometer
                    streamArbiter.requestFix(accuracy: requested, using: manager)
                }
            } onCancel: {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    guard let waiter = fixWaiters.removeValue(forKey: id) else { return }
                    streamArbiter.cancelFix(using: manager)
                    waiter.resume(throwing: CancellationError())
                }
            }
        }

        func requestTemporaryFullAccuracy() async -> Bool {
            guard let dictionary = Bundle.main.object(
                forInfoDictionaryKey: "NSLocationTemporaryUsageDescriptionDictionary"
            ) as? [String: String], let purpose = dictionary.keys.sorted().first else { return false }
            let id = UUID()
            return await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    guard !Task.isCancelled else { continuation.resume(returning: false); return }
                    accuracyWaiters[id] = continuation
                    guard accuracyRequest == nil else { return }
                    let request = UUID()
                    accuracyRequest = request
                    manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: purpose) { [weak self] _ in
                        Task { @MainActor in
                            guard let self, self.accuracyRequest == request else { return }
                            self.accuracyRequest = nil
                            let waiters = self.accuracyWaiters
                            self.accuracyWaiters.removeAll()
                            let precise = self.authorization == .authorizedPrecise
                            waiters.values.forEach { $0.resume(returning: precise) }
                        }
                    }
                }
            } onCancel: {
                Task { @MainActor [weak self] in
                    self?.accuracyWaiters.removeValue(forKey: id)?.resume(returning: false)
                }
            }
        }

        func setUpdateAccuracy(_ accuracy: String) {
            streamArbiter.updateAccuracy = accuracy == "approximate"
                ? kCLLocationAccuracyKilometer : kCLLocationAccuracyBest
        }

        func startUpdates(
            minDistanceM: Double,
            _ handler: @escaping @MainActor @Sendable (PrototypeLocationFix) -> Void
        ) {
            update = handler
            manager.distanceFilter = minDistanceM
            streamArbiter.startUpdates(using: manager)
        }

        func stopUpdates() {
            update = nil
            streamArbiter.stopUpdates(using: manager)
        }

        func locationManagerDidChangeAuthorization(_: CLLocationManager) {
            guard authorization != .notDetermined else { return }
            let waiters = authorizationWaiters
            authorizationWaiters.removeAll()
            waiters.values.forEach { $0.resume() }
            if !authorization.authorized {
                finishFixes(.failure(PrototypeLocationSourceError.permissionDenied))
            }
            authorizationChangeHandler?()
        }

        func locationManager(_: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
            guard let location = locations.last else { return }
            let fix = PrototypeLocationFix(
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                accuracyM: location.horizontalAccuracy,
                altitudeM: location.verticalAccuracy >= 0 ? location.altitude : nil,
                speedMps: location.speed >= 0 ? location.speed : nil,
                bearingDeg: location.course >= 0 ? location.course : nil,
                timestampMs: (location.timestamp.timeIntervalSince1970 * 1000).rounded(.down),
                approximate: authorization == .authorizedApproximate
            )
            finishFixes(.success(fix))
            update?(fix)
        }

        func locationManager(_: CLLocationManager, didFailWithError error: any Error) {
            let mapped: PrototypeLocationSourceError
            if let error = error as? CLError {
                switch error.code {
                case .denied: mapped = servicesEnabled ? .permissionDenied : .unavailable
                case .locationUnknown: mapped = .unavailable
                default: mapped = .platformError
                }
            } else if (error as NSError).domain == NSURLErrorDomain,
                      (error as NSError).code == NSURLErrorTimedOut
            {
                mapped = .timeout
            } else { mapped = .platformError }
            finishFixes(.failure(mapped))
        }

        private func finishFixes(_ result: Result<PrototypeLocationFix, any Error>) {
            let waiters = fixWaiters
            fixWaiters.removeAll()
            streamArbiter.finishFixes(using: manager)
            waiters.values.forEach { $0.resume(with: result) }
        }
    }
#endif
