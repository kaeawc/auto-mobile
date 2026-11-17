#if canImport(UIKit)
    import AVFAudio
    import UIKit

    @MainActor
    final class UIDeviceBatterySource: NSObject, PrototypeDeviceStatusSource {
        private var update: (@MainActor @Sendable ([String: JSONValue]) -> Void)?

        func start(_ update: @escaping @MainActor @Sendable ([String: JSONValue]) -> Void) {
            guard self.update == nil else { return }
            self.update = update
            UIDevice.current.isBatteryMonitoringEnabled = true
            for name in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification] {
                NotificationCenter.default.addObserver(self, selector: #selector(changed), name: name, object: nil)
            }
            report()
        }

        func stop() {
            for name in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification] {
                NotificationCenter.default.removeObserver(self, name: name, object: nil)
            }
            update = nil
        }

        @objc
        private nonisolated func changed() {
            Task { @MainActor [weak self] in self?.report() }
        }

        private func report() {
            let device = UIDevice.current
            var state: [String: JSONValue] = [
                "state": .string(PrototypeDeviceStatus.batteryState(device.batteryState.rawValue)),
            ]
            if let level = PrototypeDeviceStatus.batteryLevel(Double(device.batteryLevel)) {
                state["level"] = .number(level)
            }
            update?(state)
        }
    }

    @MainActor
    final class ProcessInfoPowerSource: NSObject, PrototypeDeviceStatusSource {
        private var update: (@MainActor @Sendable ([String: JSONValue]) -> Void)?

        func start(_ update: @escaping @MainActor @Sendable ([String: JSONValue]) -> Void) {
            guard self.update == nil else { return }
            self.update = update
            for name in [
                Notification.Name.NSProcessInfoPowerStateDidChange,
                ProcessInfo.thermalStateDidChangeNotification,
            ] {
                NotificationCenter.default.addObserver(self, selector: #selector(changed), name: name, object: nil)
            }
            report()
        }

        func stop() {
            for name in [
                Notification.Name.NSProcessInfoPowerStateDidChange,
                ProcessInfo.thermalStateDidChangeNotification,
            ] {
                NotificationCenter.default.removeObserver(self, name: name, object: nil)
            }
            update = nil
        }

        @objc
        private nonisolated func changed() {
            Task { @MainActor [weak self] in self?.report() }
        }

        private func report() {
            let process = ProcessInfo.processInfo
            var state: [String: JSONValue] = ["saver": .bool(process.isLowPowerModeEnabled)]
            if let thermal = PrototypeDeviceStatus.thermal(process.thermalState.rawValue) {
                state["thermal"] = .string(thermal)
            }
            update?(state)
        }
    }

    @MainActor
    final class AVAudioSessionAudioSource: NSObject, PrototypeDeviceStatusSource {
        private var update: (@MainActor @Sendable ([String: JSONValue]) -> Void)?
        private var observation: NSKeyValueObservation?

        func start(_ update: @escaping @MainActor @Sendable ([String: JSONValue]) -> Void) {
            guard self.update == nil else { return }
            self.update = update
            // Observe the existing session without activating it or changing its category.
            observation = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in self?.report() }
            }
            NotificationCenter.default.addObserver(
                self, selector: #selector(changed), name: AVAudioSession.routeChangeNotification, object: nil
            )
            report()
        }

        func stop() {
            observation?.invalidate()
            observation = nil
            NotificationCenter.default.removeObserver(
                self, name: AVAudioSession.routeChangeNotification, object: nil
            )
            update = nil
        }

        @objc
        private nonisolated func changed() {
            Task { @MainActor [weak self] in self?.report() }
        }

        private func report() {
            let session = AVAudioSession.sharedInstance()
            var state: [String: JSONValue] = [
                "route": .string(PrototypeDeviceStatus
                    .route(session.currentRoute.outputs.first?.portType.rawValue ?? "")),
            ]
            if let volume = PrototypeDeviceStatus.volume(Double(session.outputVolume)) {
                state["volume"] = .number(volume)
                // iOS exposes no ringer switch: muted means the reported whole-percent volume is zero.
                state["muted"] = .bool(volume == 0)
            }
            update?(state)
        }
    }
#endif
