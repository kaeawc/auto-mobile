@MainActor
protocol ProximityMonitoringControl: AnyObject {
    var isEnabled: Bool { get set }
}

/// Keeps the host's setting until the last prototype releases proximity monitoring.
@MainActor
final class ProximityMonitoringScope {
    private let control: any ProximityMonitoringControl
    private var users = 0
    private var priorValue = false

    init(control: any ProximityMonitoringControl) { self.control = control }

    func acquire() {
        if users == 0 {
            priorValue = control.isEnabled
            control.isEnabled = true
        }
        users += 1
    }

    func release() {
        guard users > 0 else { return }
        users -= 1
        if users == 0 { control.isEnabled = priorValue }
    }

    func probe() -> Bool {
        guard users == 0 else { return control.isEnabled }
        let prior = control.isEnabled
        control.isEnabled = true
        defer { control.isEnabled = prior }
        return control.isEnabled
    }
}

enum PrototypeMotionKind: CaseIterable, Sendable {
    case deviceMotion, accelerometer
}

/// The two continuous streams needed by orientation and shake, already mapped to sensor samples.
@MainActor
protocol PrototypeMotionManager: AnyObject {
    var isDeviceMotionAvailable: Bool { get }
    var isAccelerometerAvailable: Bool { get }
    func startDeviceMotionUpdates(_ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void)
    func stopDeviceMotionUpdates()
    func startAccelerometerUpdates(_ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void)
    func stopAccelerometerUpdates()
}

/// Shares one manager while retaining independent subscriptions and rejecting callbacks from old runs.
@MainActor
final class SharedPrototypeMotion {
    private let manager: any PrototypeMotionManager
    private var handlers: [PrototypeMotionKind: [Int: @MainActor @Sendable (PrototypeSensorSample) -> Void]] = [:]
    private var sessions: [PrototypeMotionKind: Int] = [:]
    private var nextID = 0

    init(manager: any PrototypeMotionManager) { self.manager = manager }

    var isDeviceMotionAvailable: Bool { manager.isDeviceMotionAvailable }
    var isAccelerometerAvailable: Bool { manager.isAccelerometerAvailable }

    func acquire(
        _ kind: PrototypeMotionKind,
        _ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void
    )
        -> Int
    {
        let id = nextID
        nextID += 1
        handlers[kind, default: [:]][id] = handler
        guard sessions[kind] == nil else { return id }
        sessions[kind] = id
        let update: @MainActor @Sendable (PrototypeSensorSample) -> Void = { [weak self] sample in
            self?.deliver(sample, kind: kind, session: id)
        }
        switch kind {
        case .deviceMotion: manager.startDeviceMotionUpdates(update)
        case .accelerometer: manager.startAccelerometerUpdates(update)
        }
        return id
    }

    func release(_ kind: PrototypeMotionKind, id: Int) {
        guard handlers[kind]?.removeValue(forKey: id) != nil, handlers[kind]?.isEmpty == true else { return }
        sessions[kind] = nil
        switch kind {
        case .deviceMotion: manager.stopDeviceMotionUpdates()
        case .accelerometer: manager.stopAccelerometerUpdates()
        }
    }

    private func deliver(_ sample: PrototypeSensorSample, kind: PrototypeMotionKind, session: Int) {
        guard sessions[kind] == session else { return }
        for (id, handler) in handlers[kind] ?? [:] where handlers[kind]?[id] != nil {
            handler(sample)
        }
    }
}
