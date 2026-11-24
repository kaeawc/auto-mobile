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

final class PrivateSimulatorBackend: SimulatorScreenBackend, CarPlayHIDBackend {
    private var device: NSObject?
    private var screenObjects: [UInt32: NSObject] = [:]
    private var simulatorKit: UnsafeMutableRawPointer?
    private var hidClient: NSObject?
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

    func selectBootedDevice(udid: String) throws -> SimulatorDevice {
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
        guard let dataPath = try object(selected, "dataPath") as? NSString,
              let version = try object(object(selected, "runtime"), "versionString") as? NSString
        else { throw unavailable("SimDevice.dataPath or runtime.versionString") }
        return SimulatorDevice(runtimeVersion: version as String, dataPath: dataPath as String)
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

    func writeFile(_ data: Data, path: String) throws {
        do {
            try FileManager.default.createDirectory(
                atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true
            )
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        } catch {
            throw CarPlayPowerError(.powerOnFailed, "Cannot write \(path): \(error.localizedDescription)")
        }
    }

    func readFile(path: String) throws -> Data? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        do { return try Data(contentsOf: URL(fileURLWithPath: path)) } catch {
            throw CarPlayPowerError(.hidFailed, "Cannot read \(path): \(error.localizedDescription)")
        }
    }

    private func carPlayPropertyKey(_ symbol: String) throws -> NSString {
        guard let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), symbol) else { throw unavailable(symbol) }
        return pointer.assumingMemoryBound(to: NSString.self).pointee
    }

    /// Switching TVOut's mode with CarPlay properties powers it on; backboardd then re-reads
    /// the StarkConfig plist and makes TVOut the car display.
    func setCarPlayMode(screenID: UInt32, width: Double, height: Double) throws {
        guard let screen = screenObjects[screenID] else {
            throw CarPlayPowerError(.noCarPlayScreen, "TVOut screen disappeared; enumerate and retry.")
        }
        let mode = try object(object(screen, "screenProperties"), "currentMode")
        let properties: NSDictionary = try [
            carPlayPropertyKey("SimCarPlayPropertyKeyHasTouchScreen"): true,
            carPlayPropertyKey("SimCarPlayPropertyKeyStark"): true,
        ]
        let name = "setCurrentMode:pixelSize:carPlayProperties:completionQueue:completionHandler:"
        let result = CallbackResult()
        let completion: @convention(block) (NSError?) -> Void = { error in result.finish(error: error) }
        typealias Call = @convention(c) (AnyObject, Selector, AnyObject, CGSize, AnyObject, AnyObject, AnyObject)
            -> Void
        let call = try unsafeBitCast(implementation(screen, name), to: Call.self)
        call(
            screen, NSSelectorFromString(name), mode, CGSize(width: width, height: height), properties,
            queue as AnyObject, completion as AnyObject
        )
        _ = try result.wait(code: .powerOnFailed, timeout: 20)
    }

    // MARK: CarPlay HID (#18730)

    private func simulatorKitSymbol(_ name: String) throws -> UnsafeMutableRawPointer {
        if simulatorKit == nil {
            let path = try (developerDirectory() as NSString)
                .appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit")
            guard let handle = dlopen(path, RTLD_NOW) else { throw unavailable("SimulatorKit at \(path)") }
            simulatorKit = handle
        }
        guard let symbol = dlsym(simulatorKit, name) else { throw unavailable(name) }
        return symbol
    }

    /// SimDeviceLegacyHIDClient for the selected device, opened once per helper run.
    private func legacyHIDClient() throws -> NSObject {
        if let hidClient { return hidClient }
        _ = try simulatorKitSymbol("IndigoHIDMessageForMouseNSEvent")
        let className = "_TtC12SimulatorKit24SimDeviceLegacyHIDClient"
        let allocName = "alloc"
        let initName = "initWithDevice:error:"
        guard let hidClass = NSClassFromString(className),
              let allocMethod = class_getClassMethod(hidClass, NSSelectorFromString(allocName)),
              let initMethod = class_getInstanceMethod(hidClass, NSSelectorFromString(initName))
        else { throw unavailable("\(className).\(initName)") }
        typealias AllocCall = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
        typealias InitCall = @convention(c) (
            AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>
        )
            -> Unmanaged<AnyObject>?
        let alloc = unsafeBitCast(method_getImplementation(allocMethod), to: AllocCall.self)
        guard let allocated = alloc(hidClass as AnyObject, NSSelectorFromString(allocName)) else {
            throw unavailable("\(className).\(allocName)")
        }
        var error: NSError?
        let initialize = unsafeBitCast(method_getImplementation(initMethod), to: InitCall.self)
        // init consumes the +1 from alloc and returns a +1 reference.
        guard let client = try initialize(
            allocated.takeUnretainedValue(), NSSelectorFromString(initName), selectedDevice(), &error
        )?.takeRetainedValue() as? NSObject else {
            throw CarPlayPowerError(
                .hidFailed,
                "Cannot open the simulator HID client (\(error?.localizedDescription ?? "no error")); reboot the simulator and retry."
            )
        }
        hidClient = client
        return client
    }

    private func send(_ message: UnsafeMutableRawPointer?, _ what: String) throws {
        guard let message else {
            throw CarPlayPowerError(.hidFailed, "SimulatorKit built no \(what) message; check DEVELOPER_DIR.")
        }
        let client = try legacyHIDClient()
        let name = "sendWithMessage:freeWhenDone:completionQueue:completion:"
        typealias Call = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject, AnyObject)
            -> Void
        let call = try unsafeBitCast(implementation(client, name), to: Call.self)
        let result = CallbackResult()
        let completion: @convention(block) (NSError?) -> Void = { error in result.finish(error: error) }
        call(client, NSSelectorFromString(name), message, ObjCBool(true), queue as AnyObject, completion as AnyObject)
        _ = try result.wait(code: .hidFailed)
    }

    func createCarPlayService() throws {
        typealias Create = @convention(c) (ObjCBool) -> UnsafeMutableRawPointer?
        let create = try unsafeBitCast(simulatorKitSymbol("IndigoHIDMessageToCreateCarPlayService"), to: Create.self)
        try send(create(ObjCBool(true)), "create CarPlay service")
    }

    func sendTouch(_ phase: CarPlayTouchPhase, target: UInt32, x: Double, y: Double, width: Double, height: Double)
        throws
    {
        typealias Mouse = @convention(c) (
            UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<CGPoint>?, UInt32, UInt, CGSize, UInt32
        ) -> UnsafeMutableRawPointer?
        let mouse = try unsafeBitCast(simulatorKitSymbol("IndigoHIDMessageForMouseNSEvent"), to: Mouse.self)
        var point = CGPoint(x: x, y: y)
        // NSEventTypeLeftMouseDown is 1 and NSEventTypeLeftMouseUp is 2; the message divides the
        // point by the size, so both are car-screen pixels.
        let eventType: UInt = phase == .down ? 1 : 2
        try send(mouse(&point, nil, target, eventType, CGSize(width: width, height: height), 0), "touch \(phase)")
    }

    // MARK: CarPlay head-unit inputs (#19059)

    func sendUsage(_ phase: CarPlayTouchPhase, target: UInt32, page: UInt32, usage: UInt32) throws {
        // IndigoHIDMessageForHIDArbitrary(IndigoHIDTarget, usagePage, usage, IndigoHIDButtonOp).
        typealias Arbitrary = @convention(c) (UInt32, UInt32, UInt32, Int32) -> UnsafeMutableRawPointer?
        let arbitrary = try unsafeBitCast(simulatorKitSymbol("IndigoHIDMessageForHIDArbitrary"), to: Arbitrary.self)
        // IndigoHIDButtonOp: down is 1, up is 2.
        let operation: Int32 = phase == .down ? 1 : 2
        try send(arbitrary(target, page, usage, operation), "usage 0x\(String(usage, radix: 16)) \(phase)")
    }

    func sendScroll(target: UInt32, delta: Double) throws {
        let iokitPath = "/System/Library/Frameworks/IOKit.framework/IOKit"
        let createName = "IOHIDEventCreateScrollEvent"
        guard let iokit = dlopen(iokitPath, RTLD_NOW), let createSymbol = dlsym(iokit, createName) else {
            throw unavailable(createName)
        }
        // IOHIDEventCreateScrollEvent(CFAllocatorRef, AbsoluteTime, IOHIDFloat x, y, z, IOOptionBits).
        typealias Create = @convention(c) (CFAllocator?, UInt64, Double, Double, Double, UInt32)
            -> Unmanaged<CFTypeRef>?
        // IndigoHIDMessageForScrollEventFromHIDEventRef(IOHIDEventRef, IndigoHIDTarget).
        typealias Scroll = @convention(c) (CFTypeRef, UInt32) -> UnsafeMutableRawPointer?
        let scroll = try unsafeBitCast(
            simulatorKitSymbol("IndigoHIDMessageForScrollEventFromHIDEventRef"),
            to: Scroll.self
        )
        let create = unsafeBitCast(createSymbol, to: Create.self)
        guard let event = create(kCFAllocatorDefault, mach_absolute_time(), 0, delta, 0, 0)?.takeRetainedValue()
        else { throw CarPlayPowerError(.hidFailed, "\(createName) returned no event.") }
        try send(scroll(event, target), "knob rotation")
    }

    func hold(milliseconds: Int) {
        usleep(UInt32(milliseconds) * 1000)
    }
}
