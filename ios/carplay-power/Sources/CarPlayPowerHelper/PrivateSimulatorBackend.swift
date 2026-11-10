import CarPlayPowerCore
import Darwin
import Foundation
import ObjectiveC

/// Private objects cross only this callback handoff. NSCondition protects all mutable fields;
/// the CLI consumes the objects serially after the callback finishes, never concurrently.
private final class CallbackResult: @unchecked Sendable {
    private let condition = NSCondition()
    private var completed = false
    private var objects: [NSObject] = []
    private var failure: String?

    func finish(_ objects: [NSObject] = [], error: NSError?) {
        condition.lock()
        defer { condition.unlock() }
        self.objects = objects
        failure = error?.localizedDescription
        completed = true
        condition.signal()
    }

    func wait(code: CarPlayErrorCode, timeout: TimeInterval = 5) throws -> [NSObject] {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !completed {
            guard condition.wait(until: deadline) else {
                throw CarPlayPowerError(code, "CoreSimulator callback timed out; retry or check Xcode compatibility.")
            }
        }
        if let failure { throw CarPlayPowerError(code, failure) }
        return objects
    }
}

final class PrivateSimulatorBackend: SimulatorScreenBackend {
    private var device: NSObject?
    private var screenObjects: [UInt32: NSObject] = [:]
    private let queue = DispatchQueue(label: "auto-mobile.carplay-power.callback")

    private func implementation(_ object: NSObject, _ name: String) throws -> IMP {
        let selector = NSSelectorFromString(name)
        guard object.responds(to: selector), let implementation = object.method(for: selector) else {
            throw unavailable(name)
        }
        return implementation
    }

    private func unavailable(_ name: String) -> CarPlayPowerError {
        CarPlayPowerError(
            .privateAPIUnavailable,
            "CoreSimulator private API \(name) is unavailable. Check xcode-select/DEVELOPER_DIR and use a supported Xcode; rebuild the helper after upgrading Xcode."
        )
    }

    private func object(_ target: NSObject, _ name: String) throws -> NSObject {
        typealias Call = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
        let call = try unsafeBitCast(implementation(target, name), to: Call.self)
        guard let result = call(target, NSSelectorFromString(name))?.takeUnretainedValue() as? NSObject else {
            throw unavailable(name)
        }
        return result
    }

    func selectBootedDevice(udid: String) throws {
        guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil,
              let contextClass = NSClassFromString("SimServiceContext")
        else { throw unavailable("SimServiceContext") }
        let name = "sharedServiceContextForDeveloperDir:error:"
        let selector = NSSelectorFromString(name)
        guard let method = class_getClassMethod(contextClass, selector) else { throw unavailable(name) }
        typealias ContextCall = @convention(c) (
            AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>
        )
            -> Unmanaged<AnyObject>?
        var error: NSError?
        let call = unsafeBitCast(method_getImplementation(method), to: ContextCall.self)
        guard let context = try call(contextClass as AnyObject, selector, developerDirectory() as NSString, &error)?
            .takeUnretainedValue() as? NSObject
        else { throw unavailable(error?.localizedDescription ?? name) }
        typealias SetCall = @convention(c) (
            AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>
        )
            -> Unmanaged<AnyObject>?
        let setName = "defaultDeviceSetWithError:"
        let setCall = try unsafeBitCast(implementation(context, setName), to: SetCall.self)
        guard let set = setCall(context, NSSelectorFromString(setName), &error)?.takeUnretainedValue() as? NSObject,
              let devices = try object(set, "devicesByUDID") as? NSDictionary
        else { throw unavailable(error?.localizedDescription ?? setName) }
        guard let selected = devices.first(where: { entry in
            (entry.key as? NSUUID)?.uuidString.caseInsensitiveCompare(udid) == .orderedSame
        })?.value as? NSObject else {
            throw CarPlayPowerError(
                .deviceNotFound,
                "Simulator \(udid) was not found in the default device set; check its UDID."
            )
        }
        typealias StateCall = @convention(c) (AnyObject, Selector) -> UInt64
        let state = try unsafeBitCast(implementation(selected, "state"), to: StateCall.self)
        guard state(selected, NSSelectorFromString("state")) == 3 else {
            throw CarPlayPowerError(
                .deviceNotBooted,
                "Simulator \(udid) is not booted; boot it before running this helper."
            )
        }
        device = selected
    }

    private func developerDirectory() throws -> String {
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

    private func selectedDevice() throws -> NSObject {
        guard let device else { throw CarPlayPowerError(.deviceNotFound, "Select a booted simulator first.") }
        return device
    }

    func enableCarPlay() throws {
        let device = try selectedDevice()
        let name = "enableCarPlay:error:"
        typealias Call = @convention(c) (
            AnyObject, Selector, Bool, AutoreleasingUnsafeMutablePointer<NSError?>
        )
            -> Bool
        let call = try unsafeBitCast(implementation(device, name), to: Call.self)
        var error: NSError?
        guard call(device, NSSelectorFromString(name), true, &error) else {
            throw CarPlayPowerError(
                .powerOnFailed,
                "enableCarPlay failed: \(error?.localizedDescription ?? "CoreSimulator refused enablement")"
            )
        }
    }

    func settle() throws { Thread.sleep(forTimeInterval: 3) }

    func screens() throws -> [SimulatorScreen] {
        let deviceIO = try object(selectedDevice(), "io")
        let updateName = "updateIOPorts"
        typealias UpdateCall = @convention(c) (AnyObject, Selector) -> Void
        try unsafeBitCast(implementation(deviceIO, updateName), to: UpdateCall.self)(
            deviceIO,
            NSSelectorFromString(updateName)
        )
        guard let ports = try object(deviceIO, "ioPorts") as? [NSObject] else { throw unavailable("ioPorts") }
        let enumerateName = "enumerateScreensWithCompletionQueue:completionHandler:"
        // SimScreenAdapter is the framebuffer server descriptor. Other port descriptors do not
        // implement screen enumeration; capability detection avoids relying on a private class name.
        let adapters = try ports.map { try object($0, "descriptor") }
            .filter { $0.responds(to: NSSelectorFromString(enumerateName)) }
        guard !adapters.isEmpty
        else { throw unavailable("com.apple.framebuffer.server SimScreenAdapter.\(enumerateName)") }
        screenObjects = [:]
        return try adapters.flatMap { adapter in
            let result = CallbackResult()
            let completion: @convention(block) (NSArray?, NSError?) -> Void = { screens, error in
                result.finish(screens as? [NSObject] ?? [], error: error)
            }
            typealias EnumerateCall = @convention(c) (AnyObject, Selector, AnyObject, AnyObject) -> Void
            let enumerate = try unsafeBitCast(implementation(adapter, enumerateName), to: EnumerateCall.self)
            enumerate(adapter, NSSelectorFromString(enumerateName), queue as AnyObject, completion as AnyObject)
            return try result.wait(code: .privateAPIUnavailable, timeout: 60).map { screen in
                let properties = try readProperties(screen)
                screenObjects[properties.id] = screen
                return properties
            }
        }
    }

    private func readProperties(_ screen: NSObject) throws -> SimulatorScreen {
        let properties = try object(screen, "screenProperties")
        typealias IDCall = @convention(c) (AnyObject, Selector) -> UInt32
        typealias TypeCall = @convention(c) (AnyObject, Selector) -> UInt64
        typealias PowerCall = @convention(c) (AnyObject, Selector) -> Int32
        typealias SizeCall = @convention(c) (AnyObject, Selector) -> CGSize
        let idCall = try unsafeBitCast(implementation(properties, "screenID"), to: IDCall.self)
        let typeCall = try unsafeBitCast(implementation(properties, "screenType"), to: TypeCall.self)
        let powerCall = try unsafeBitCast(implementation(properties, "powerState"), to: PowerCall.self)
        let sizeCall = try unsafeBitCast(implementation(properties, "pixelSize"), to: SizeCall.self)
        let size = sizeCall(properties, NSSelectorFromString("pixelSize"))
        guard let name = try object(properties, "name") as? NSString else { throw unavailable("screenProperties.name") }
        return SimulatorScreen(
            id: idCall(properties, NSSelectorFromString("screenID")), name: name as String,
            screenType: typeCall(properties, NSSelectorFromString("screenType")),
            powerState: powerCall(properties, NSSelectorFromString("powerState")), width: size.width,
            height: size.height
        )
    }

    func powerOn(screenID: UInt32) throws {
        guard let screen = screenObjects[screenID] else {
            throw CarPlayPowerError(.noCarPlayScreen, "CarPlay screen disappeared; enumerate and retry.")
        }
        let name = "setPowerState:completionQueue:completionHandler:"
        let result = CallbackResult()
        let completion: @convention(block) (NSError?) -> Void = { error in result.finish(error: error) }
        typealias Call = @convention(c) (AnyObject, Selector, Int32, AnyObject, AnyObject) -> Void
        let call = try unsafeBitCast(implementation(screen, name), to: Call.self)
        call(screen, NSSelectorFromString(name), 1, queue as AnyObject, completion as AnyObject)
        _ = try result.wait(code: .powerOnFailed)
    }
}
