#if canImport(UIKit) && canImport(CoreMotion)
    import CoreMotion
    import Foundation
    import UIKit

    /// One source owns the managers and proximity observer for one registry's active prototype.
    @MainActor
    final class CoreMotionPrototypeSensorSource: PrototypeSensorSource {
        private lazy var motion = CMMotionManager()
        private var pedometer: CMPedometer?
        private var started: Set<PrototypeSensor> = []
        private var handlers: [PrototypeSensor: @MainActor @Sendable (PrototypeSensorSample) -> Void] = [:]
        private var generation = 0
        private var proximityObserver: (any NSObjectProtocol)?
        private var monitoringProximity = false

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
            case .orientation: return motion.isDeviceMotionAvailable
            case .shake: return motion.isAccelerometerAvailable
            case .steps:
                guard Bundle.main.object(forInfoDictionaryKey: "NSMotionUsageDescription") != nil else { return false }
                return CMPedometer.isStepCountingAvailable()
            case .light: return false
            case .proximity:
                // UIKit exposes no separate availability API. Unsupported devices leave this false.
                UIDevice.current.isProximityMonitoringEnabled = true
                monitoringProximity = UIDevice.current.isProximityMonitoringEnabled
                return monitoringProximity
            }
        }

        func start(
            _ sensor: PrototypeSensor, rateHz: Int,
            _ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void
        ) {
            guard handlers[sensor] == nil, sensor != .light, hasSensor(sensor),
                  sensor != .steps || stepsAllowed else { return }
            handlers[sensor] = handler
            started.insert(sensor)
            let session = generation
            switch sensor {
            case .orientation:
                motion.deviceMotionUpdateInterval = 1 / Double(max(1, min(30, rateHz)))
                let frames = CMMotionManager.availableAttitudeReferenceFrames()
                let frame: CMAttitudeReferenceFrame = frames.contains(.xMagneticNorthZVertical)
                    ? .xMagneticNorthZVertical : .xArbitraryZVertical
                motion.startDeviceMotionUpdates(using: frame, to: .main) { [weak self] reading, _ in
                    guard let reading else { return }
                    var values = [
                        "pitchDeg": reading.attitude.pitch * 180 / .pi,
                        "rollDeg": reading.attitude.roll * 180 / .pi,
                    ]
                    if reading.heading >= 0 { values["headingDeg"] = reading.heading }
                    let sample = PrototypeSensorSample.values(values)
                    Task { @MainActor in self?.deliver(sample, sensor: .orientation, session: session) }
                }
            case .shake:
                motion.accelerometerUpdateInterval = 1 / 50.0
                motion.startAccelerometerUpdates(to: .main) { [weak self] reading, _ in
                    guard let acceleration = reading?.acceleration else { return }
                    // CoreMotion reports g; the shared shake contract and fixtures use m/s².
                    let sample = PrototypeSensorSample.acceleration(
                        x: acceleration.x * 9.80665, y: acceleration.y * 9.80665, z: acceleration.z * 9.80665
                    )
                    Task { @MainActor in self?.deliver(sample, sensor: .shake, session: session) }
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
            if started.contains(.orientation) { motion.stopDeviceMotionUpdates() }
            if started.contains(.shake) { motion.stopAccelerometerUpdates() }
            if started.contains(.steps) { pedometer?.stopUpdates() }
            started.removeAll()
            if let proximityObserver { NotificationCenter.default.removeObserver(proximityObserver) }
            proximityObserver = nil
            if monitoringProximity { UIDevice.current.isProximityMonitoringEnabled = false }
            monitoringProximity = false
        }
    }
#endif
