import Darwin
import Foundation
import IOSurface
import ObjectiveC

/// Source of the booted Simulator's main-display framebuffer. The protocol is the
/// seam `FramebufferCaptureSession` tests use instead of CoreSimulator.
protocol SimulatorFramebufferSource: AnyObject {
    /// The main display's live BGRA IOSurface. CoreSimulator keeps one surface per
    /// display and changes its seed on every new frame; a rotation or display
    /// reconfiguration can replace it, so callers re-fetch it periodically.
    func mainDisplaySurface() throws -> IOSurfaceRef
}

struct SimulatorFramebufferError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Reads the main display IOSurface of a booted Simulator through CoreSimulator's
/// private API (#19015), with no Simulator.app or Device Hub window and no Screen
/// Recording permission:
///
///   SimServiceContext → default SimDeviceSet → SimDevice.io → updateIOPorts → ioPorts
///   → port.descriptor that responds to framebufferSurface
///   → descriptor.state.displayClass == 0 (main display) → framebufferSurface
///
/// `descriptor.state` is a ROCKImmutableProxy: its methods are forwarded, so
/// `responds(to:)`/`method(for:)` cannot see them. Those two calls go through a raw
/// `objc_msgSend` cast.
final class CoreSimulatorFramebufferSource: SimulatorFramebufferSource {
    private let udid: String
    private var descriptor: NSObject?

    init(udid: String) {
        self.udid = udid
    }

    func mainDisplaySurface() throws -> IOSurfaceRef {
        let descriptor = try self.descriptor ?? resolveMainDisplayDescriptor()
        self.descriptor = descriptor
        guard let surface = try? object(descriptor, "framebufferSurface") else {
            // The descriptor goes stale when the device's IO ports are rebuilt.
            self.descriptor = nil
            throw unavailable("framebufferSurface")
        }
        return unsafeBitCast(surface, to: IOSurfaceRef.self)
    }

    private func resolveMainDisplayDescriptor() throws -> NSObject {
        let device = try bootedDevice()
        let io = try object(device, "io")
        typealias VoidCall = @convention(c) (AnyObject, Selector) -> Void
        try unsafeBitCast(implementation(io, "updateIOPorts"), to: VoidCall.self)(
            io,
            NSSelectorFromString("updateIOPorts")
        )
        guard let ports = try object(io, "ioPorts") as? [NSObject] else { throw unavailable("ioPorts") }
        let displays = ports.compactMap { try? object($0, "descriptor") }
            .filter { $0.responds(to: NSSelectorFromString("framebufferSurface")) }
        guard let main = displays.first(where: { displayClass($0) == 0 }) else {
            throw SimulatorFramebufferError(
                message: "Simulator \(udid) exposes no main display framebuffer (\(displays.count) display ports)."
            )
        }
        return main
    }

    private func displayClass(_ descriptor: NSObject) -> UInt16? {
        guard let state = rawObject(descriptor, "state") else { return nil }
        typealias Call = @convention(c) (AnyObject, Selector) -> UInt16
        return unsafeBitCast(Self.objcMsgSend, to: Call.self)(state, NSSelectorFromString("displayClass"))
    }

    private func bootedDevice() throws -> NSObject {
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
        let contextCall = unsafeBitCast(method_getImplementation(method), to: ContextCall.self)
        guard let context = try contextCall(
            contextClass as AnyObject,
            selector,
            developerDirectory() as NSString,
            &error
        )?
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
        guard let device = devices.first(where: { entry in
            (entry.key as? NSUUID)?.uuidString.caseInsensitiveCompare(udid) == .orderedSame
        })?.value as? NSObject else {
            throw SimulatorFramebufferError(message: "Simulator \(udid) was not found in the default device set.")
        }
        typealias StateCall = @convention(c) (AnyObject, Selector) -> UInt64
        let state = try unsafeBitCast(implementation(device, "state"), to: StateCall.self)
        // SimDeviceState 3 = Booted.
        guard state(device, NSSelectorFromString("state")) == 3 else {
            throw SimulatorFramebufferError(message: "Simulator \(udid) is not booted.")
        }
        return device
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

    /// `nonisolated(unsafe)`: the runtime's immutable function address, resolved once.
    private nonisolated(unsafe) static let objcMsgSend: UnsafeMutableRawPointer = {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend") else {
            preconditionFailure("objc_msgSend is always present in the Objective-C runtime")
        }
        return symbol
    }()

    private func rawObject(_ target: NSObject, _ name: String) -> NSObject? {
        typealias Call = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
        return unsafeBitCast(Self.objcMsgSend, to: Call.self)(target, NSSelectorFromString(name))?
            .takeUnretainedValue() as? NSObject
    }

    private func implementation(_ target: NSObject, _ name: String) throws -> IMP {
        let selector = NSSelectorFromString(name)
        guard target.responds(to: selector), let implementation = target.method(for: selector) else {
            throw unavailable(name)
        }
        return implementation
    }

    private func object(_ target: NSObject, _ name: String) throws -> NSObject {
        typealias Call = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
        let call = try unsafeBitCast(implementation(target, name), to: Call.self)
        guard let result = call(target, NSSelectorFromString(name))?.takeUnretainedValue() as? NSObject else {
            throw unavailable(name)
        }
        return result
    }

    private func unavailable(_ name: String) -> SimulatorFramebufferError {
        SimulatorFramebufferError(
            message: "CoreSimulator private API \(name) is unavailable; check DEVELOPER_DIR/xcode-select and the Xcode version."
        )
    }
}
