#if canImport(SimHidCore)
    import SimHidCore
#endif
import Darwin
import Foundation
import ObjectiveC

/// Completion handoff from SimulatorKit's queue. NSCondition guards every mutable field.
private final class Completion: @unchecked Sendable {
    private let condition = NSCondition()
    private var done = false
    private var failure: String?

    func finish(_ error: NSError?) {
        condition.lock()
        defer { condition.unlock() }
        failure = error?.localizedDescription
        done = true
        condition.signal()
    }

    func wait(timeout: TimeInterval) throws {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !done {
            guard condition.wait(until: deadline) else {
                throw SimHidError("send-failed", "SimulatorKit did not complete a HID message within \(Int(timeout)) s")
            }
        }
        if let failure { throw SimHidError("send-failed", failure) }
    }
}

/// Host-side HID input through SimulatorKit's SimDeviceLegacyHIDClient (#19019). Needs no XCTest
/// runner in the guest; the same client Simulator.app and carplay-power-helper use.
final class SimulatorKitHIDBackend: SimHidSender {
    private typealias Mouse = @convention(c) (
        UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<CGPoint>?, UInt32, UInt, UInt, Double, Double
    )
        -> UnsafeMutableRawPointer?
    private typealias Button = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    private typealias Key = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
    private typealias Send = @convention(c) (
        AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject, AnyObject
    )
        -> Void

    private static let digitizerTarget: UInt32 = 0x32
    private static let buttonTarget: UInt32 = 0x33
    private static let sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")

    private let client: NSObject
    private let sendCall: Send
    private let mouse: Mouse
    private let button: Button
    private let key: Key
    private let queue = DispatchQueue(label: "auto-mobile.sim-hid.completion")

    init(udid: String) throws {
        let developerDir = try Self.developerDirectory()
        let device = try Self.bootedDevice(udid: udid, developerDir: developerDir)
        let simulatorKit = try Self.openSimulatorKit(developerDir: developerDir)
        mouse = try unsafeBitCast(Self.symbol(simulatorKit, "IndigoHIDMessageForMouseNSEvent"), to: Mouse.self)
        button = try unsafeBitCast(Self.symbol(simulatorKit, "IndigoHIDMessageForButton"), to: Button.self)
        key = try unsafeBitCast(Self.symbol(simulatorKit, "IndigoHIDMessageForKeyboardArbitrary"), to: Key.self)
        client = try Self.legacyHIDClient(device: device)
        guard client.responds(to: Self.sendSelector), let implementation = client.method(for: Self.sendSelector) else {
            throw Self.unavailable("SimDeviceLegacyHIDClient.sendWithMessage:freeWhenDone:completionQueue:completion:")
        }
        sendCall = unsafeBitCast(implementation, to: Send.self)
    }

    func send(_ step: SimHidStep) throws {
        switch step {
        case let .touch(point, second, phase):
            var first = CGPoint(x: point.x, y: point.y)
            // Width and height 1.0: the points are already normalized to the screen.
            let message: UnsafeMutableRawPointer? = if let second {
                withUnsafeMutablePointer(to: &first) { firstPointer in
                    var secondPoint = CGPoint(x: second.x, y: second.y)
                    return mouse(firstPointer, &secondPoint, Self.digitizerTarget, phase.rawValue, 0, 1.0, 1.0)
                }
            } else {
                mouse(&first, nil, Self.digitizerTarget, phase.rawValue, 0, 1.0, 1.0)
            }
            try deliver(message, "touch")
        case let .button(source, down):
            try deliver(button(source, down ? 1 : 2, Self.buttonTarget), "button")
        case let .key(usage, down):
            try deliver(key(usage, down ? 1 : 2), "key")
        case let .wait(ms):
            sleep(milliseconds: ms)
        }
    }

    func sleep(milliseconds: Double) {
        guard milliseconds > 0 else { return }
        usleep(UInt32(min(milliseconds, SimHidRequestParser.maxDurationMs) * 1000))
    }

    func nowMs() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
    }

    private func deliver(_ message: UnsafeMutableRawPointer?, _ what: String) throws {
        guard let message else {
            throw SimHidNotSent(SimHidError(
                "send-failed",
                "SimulatorKit built no \(what) message (a drag sent too soon is coalesced)"
            ))
        }
        let completion = Completion()
        let block: @convention(block) (NSError?) -> Void = { error in completion.finish(error) }
        sendCall(client, Self.sendSelector, message, ObjCBool(true), queue as AnyObject, block as AnyObject)
        try completion.wait(timeout: 5)
    }

    // MARK: Private API lookup

    private static func unavailable(_ name: String) -> SimHidError {
        SimHidError(
            "private-api-unavailable",
            "CoreSimulator/SimulatorKit API \(name) is unavailable; check DEVELOPER_DIR and use a supported Xcode."
        )
    }

    private static func developerDirectory() throws -> String {
        if let value = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !value.isEmpty { return value }
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        process.arguments = ["-p"]
        process.standardOutput = output
        process.standardError = Pipe()
        do { try process.run() } catch { throw unavailable("xcode-select -p: \(error.localizedDescription)") }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let directory = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard process.terminationStatus == 0, !directory.isEmpty else { throw unavailable("xcode-select -p") }
        return directory
    }

    private static func implementation(_ object: NSObject, _ name: String) throws -> IMP {
        let selector = NSSelectorFromString(name)
        guard object.responds(to: selector), let implementation = object.method(for: selector) else {
            throw unavailable(name)
        }
        return implementation
    }

    private static func bootedDevice(udid: String, developerDir: String) throws -> NSObject {
        guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil,
              let contextClass = NSClassFromString("SimServiceContext")
        else { throw unavailable("SimServiceContext") }
        let contextName = "sharedServiceContextForDeveloperDir:error:"
        guard let method = class_getClassMethod(contextClass, NSSelectorFromString(contextName)) else {
            throw unavailable(contextName)
        }
        typealias ContextCall = @convention(c) (
            AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>
        )
            -> Unmanaged<AnyObject>?
        var error: NSError?
        let contextCall = unsafeBitCast(method_getImplementation(method), to: ContextCall.self)
        guard let context = contextCall(
            contextClass as AnyObject, NSSelectorFromString(contextName), developerDir as NSString, &error
        )?.takeUnretainedValue() as? NSObject else { throw unavailable(error?.localizedDescription ?? contextName) }
        typealias SetCall = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>)
            -> Unmanaged<AnyObject>?
        let setName = "defaultDeviceSetWithError:"
        let setCall = try unsafeBitCast(implementation(context, setName), to: SetCall.self)
        guard let set = setCall(context, NSSelectorFromString(setName), &error)?.takeUnretainedValue() as? NSObject,
              let devices = set.value(forKey: "devicesByUDID") as? NSDictionary
        else { throw unavailable(error?.localizedDescription ?? setName) }
        guard let device = devices.first(where: { entry in
            (entry.key as? NSUUID)?.uuidString.caseInsensitiveCompare(udid) == .orderedSame
        })?.value as? NSObject else {
            throw SimHidError("device-not-found", "Simulator \(udid) is not in the default device set")
        }
        typealias StateCall = @convention(c) (AnyObject, Selector) -> UInt64
        let state = try unsafeBitCast(implementation(device, "state"), to: StateCall.self)
        // SimDeviceState 3 is Booted.
        guard state(device, NSSelectorFromString("state")) == 3 else {
            throw SimHidError("device-not-booted", "Simulator \(udid) is not booted")
        }
        return device
    }

    /// Xcode 27 moved SimulatorKit to Contents/SharedFrameworks; Xcode 26 keeps it under the developer dir.
    private static func openSimulatorKit(developerDir: String) throws -> UnsafeMutableRawPointer {
        let developer = developerDir as NSString
        let paths = [
            developer.appendingPathComponent("../SharedFrameworks/SimulatorKit.framework/SimulatorKit"),
            developer.appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"),
        ]
        guard let handle = paths.lazy.compactMap({ dlopen($0, RTLD_NOW) }).first else {
            throw unavailable("SimulatorKit under \(developerDir)")
        }
        return handle
    }

    private static func symbol(_ handle: UnsafeMutableRawPointer, _ name: String) throws -> UnsafeMutableRawPointer {
        guard let pointer = dlsym(handle, name) else { throw unavailable(name) }
        return pointer
    }

    private static func legacyHIDClient(device: NSObject) throws -> NSObject {
        let className = "_TtC12SimulatorKit24SimDeviceLegacyHIDClient"
        let initName = "initWithDevice:error:"
        guard let hidClass = NSClassFromString(className),
              let allocMethod = class_getClassMethod(hidClass, NSSelectorFromString("alloc")),
              let initMethod = class_getInstanceMethod(hidClass, NSSelectorFromString(initName))
        else { throw unavailable("\(className).\(initName)") }
        typealias AllocCall = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
        typealias InitCall = @convention(c) (
            AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>
        )
            -> Unmanaged<AnyObject>?
        let alloc = unsafeBitCast(method_getImplementation(allocMethod), to: AllocCall.self)
        guard let allocated = alloc(hidClass as AnyObject, NSSelectorFromString("alloc")) else {
            throw unavailable("\(className).alloc")
        }
        var error: NSError?
        let initialize = unsafeBitCast(method_getImplementation(initMethod), to: InitCall.self)
        // init consumes the +1 from alloc and returns a +1 reference.
        guard let client = initialize(
            allocated.takeUnretainedValue(), NSSelectorFromString(initName), device, &error
        )?.takeRetainedValue() as? NSObject else {
            throw SimHidError(
                "hid-client-failed",
                "Cannot open the simulator HID client (\(error?.localizedDescription ?? "no error"))"
            )
        }
        return client
    }
}
