#if canImport(UIKit) && canImport(CoreMotion)
    import CoreMotion
    import Foundation
    import UIKit

    @MainActor
    private final class UIDeviceProximityMonitoringControl: ProximityMonitoringControl {
        var isEnabled: Bool {
            get { UIDevice.current.isProximityMonitoringEnabled }
            set { UIDevice.current.isProximityMonitoringEnabled = newValue }
        }
    }

    @MainActor
    private final class CoreMotionPrototypeMotionManager: PrototypeMotionManager {
        private lazy var motion = CMMotionManager()

        var isDeviceMotionAvailable: Bool { motion.isDeviceMotionAvailable }
        var isAccelerometerAvailable: Bool { motion.isAccelerometerAvailable }

        func startDeviceMotionUpdates(_ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void) {
            // Sample at the contract's maximum rate so a second source cannot be limited by the first.
            // Each module's existing filter applies its requested orientation rate independently.
            motion.deviceMotionUpdateInterval = 1 / 30.0
            let frames = CMMotionManager.availableAttitudeReferenceFrames()
            let frame: CMAttitudeReferenceFrame = frames.contains(.xMagneticNorthZVertical)
                ? .xMagneticNorthZVertical : .xArbitraryZVertical
            motion.startDeviceMotionUpdates(using: frame, to: .main) { reading, _ in
                guard let reading else { return }
                var values = [
                    "pitchDeg": reading.attitude.pitch * 180 / .pi,
                    "rollDeg": reading.attitude.roll * 180 / .pi,
                ]
                if reading.heading >= 0 { values["headingDeg"] = reading.heading }
                let sample = PrototypeSensorSample.values(values)
                Task { @MainActor in handler(sample) }
            }
        }

        func stopDeviceMotionUpdates() { motion.stopDeviceMotionUpdates() }

        func startAccelerometerUpdates(_ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void) {
            motion.accelerometerUpdateInterval = 1 / 50.0
            motion.startAccelerometerUpdates(to: .main) { reading, _ in
                guard let acceleration = reading?.acceleration else { return }
                // CoreMotion reports g; the shared shake contract and fixtures use m/s².
                let sample = PrototypeSensorSample.acceleration(
                    x: acceleration.x * 9.80665, y: acceleration.y * 9.80665, z: acceleration.z * 9.80665
                )
                Task { @MainActor in handler(sample) }
            }
        }

        func stopAccelerometerUpdates() { motion.stopAccelerometerUpdates() }
    }

    /// Each registry owns its handlers and pedometer; continuous motion and proximity are shared.
    @MainActor
    final class CoreMotionPrototypeSensorSource: PrototypeSensorSource {
        private static let motion = SharedPrototypeMotion(manager: CoreMotionPrototypeMotionManager())
        private static let proximity = ProximityMonitoringScope(control: UIDeviceProximityMonitoringControl())
        private var pedometer: CMPedometer?
        private var started: Set<PrototypeSensor> = []
        private var motionSubscriptions: [PrototypeMotionKind: Int] = [:]
        private var handlers: [PrototypeSensor: @MainActor @Sendable (PrototypeSensorSample) -> Void] = [:]
        private var generation = 0
        private var proximityObserver: (any NSObjectProtocol)?

        func makePresentationSource() -> any PrototypeSensorSource { CoreMotionPrototypeSensorSource() }

        var stepsAllowed: Bool {
            guard Bundle.main.object(forInfoDictionaryKey: "NSMotionUsageDescription") != nil else { return false }
            return switch CMPedometer.authorizationStatus() {
            case .denied, .restricted: false
            case .notDetermined, .authorized: true
            @unknown default: false
            }
        }

        func hasSensor(_ sensor: PrototypeSensor) -> Bool {
            switch sensor {
            case .orientation: return Self.motion.isDeviceMotionAvailable
            case .shake: return Self.motion.isAccelerometerAvailable
            case .steps:
                guard Bundle.main.object(forInfoDictionaryKey: "NSMotionUsageDescription") != nil else { return false }
                return CMPedometer.isStepCountingAvailable()
            case .light: return false
            case .proximity:
                // UIKit exposes no separate availability API. Unsupported devices leave this false.
                return Self.proximity.probe()
            }
        }

        func start(
            _ sensor: PrototypeSensor, rateHz _: Int,
            _ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void
        ) {
            guard handlers[sensor] == nil, sensor != .light, hasSensor(sensor),
                  sensor != .steps || stepsAllowed else { return }
            handlers[sensor] = handler
            started.insert(sensor)
            let session = generation
            switch sensor {
            case .orientation:
                motionSubscriptions[.deviceMotion] = Self.motion.acquire(.deviceMotion) { [weak self] sample in
                    self?.deliver(sample, sensor: .orientation, session: session)
                }
            case .shake:
                motionSubscriptions[.accelerometer] = Self.motion.acquire(.accelerometer) { [weak self] sample in
                    self?.deliver(sample, sensor: .shake, session: session)
                }
            case .steps:
                let pedometer = self.pedometer ?? CMPedometer()
                self.pedometer = pedometer
                // CMPedometer supplies the count since this date, including the first callback.
                pedometer.startUpdates(from: Date()) { [weak self] reading, _ in
                    guard let count = reading?.numberOfSteps.doubleValue else { return }
                    let sample = PrototypeSensorSample.values(["steps": count])
                    Task { @MainActor in self?.deliver(sample, sensor: .steps, session: session) }
                }
            case .proximity:
                Self.proximity.acquire()
                proximityObserver = NotificationCenter.default.addObserver(
                    forName: UIDevice.proximityStateDidChangeNotification, object: UIDevice.current, queue: .main
                ) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.deliver(.proximity(UIDevice.current.proximityState), sensor: .proximity, session: session)
                    }
                }
                deliver(.proximity(UIDevice.current.proximityState), sensor: .proximity, session: session)
            case .light: break
            }
        }

        private func deliver(_ sample: PrototypeSensorSample, sensor: PrototypeSensor, session: Int) {
            guard session == generation else { return }
            if sensor == .steps, !stepsAllowed { return }
            handlers[sensor]?(sample)
        }

        func stop() {
            generation += 1
            handlers.removeAll()
            for (kind, id) in motionSubscriptions {
                Self.motion.release(kind, id: id)
            }
            motionSubscriptions.removeAll()
            if started.contains(.steps) { pedometer?.stopUpdates() }
            if started.contains(.proximity) { Self.proximity.release() }
            started.removeAll()
            if let proximityObserver { NotificationCenter.default.removeObserver(proximityObserver) }
            proximityObserver = nil
        }
    }
#endif
