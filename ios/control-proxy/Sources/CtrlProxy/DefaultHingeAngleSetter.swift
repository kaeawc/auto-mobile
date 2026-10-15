import Foundation

#if os(iOS) && targetEnvironment(simulator)
    import Darwin
    import Dispatch
    import MachO

    private typealias HingeNotify = @convention(c) (
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?,
        UInt32, UnsafeRawPointer?
    )
        -> Void
    private typealias HingeSetProperty = @convention(c) (
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?,
        UnsafeRawPointer?, UnsafeRawPointer?
    )
        -> Bool
    private typealias HingeCopyProperty = @convention(c) (
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?,
        UnsafeRawPointer?
    )
        -> UnsafeMutableRawPointer?
    private typealias HingeCopyEvent = @convention(c) (
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?,
        UInt32, UnsafeMutableRawPointer?, UInt32
    )
        -> UnsafeMutableRawPointer?
    private typealias HingeSetOutputEvent = @convention(c) (
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?,
        UnsafeMutableRawPointer?
    )
        -> Int32

    private struct HingeCallbacks {
        let notify: HingeNotify
        let setProperty: HingeSetProperty
        let copyProperty: HingeCopyProperty
        let copyEvent: HingeCopyEvent
        let setOutputEvent: HingeSetOutputEvent
    }

    private let hingeNotify: HingeNotify = { _, _, _, _, _ in }
    private let hingeSetProperty: HingeSetProperty = { _, _, _, _, _ in false }
    private let hingeCopyProperty: HingeCopyProperty = { _, _, _, key in
        guard let key else { return nil }
        let name = Unmanaged<CFString>.fromOpaque(key).takeUnretainedValue() as String
        let value: AnyObject
        switch name {
        case "PrimaryUsagePage": value = NSNumber(value: 0xFF61)
        case "PrimaryUsage": value = NSNumber(value: 0x5B)
        case "DeviceUsagePairs":
            value = [["DeviceUsagePage": 0xFF61, "DeviceUsage": 0x5B]] as NSArray
        case "Product": value = "AutoMobile CtrlProxy Hinge" as NSString
        case "Transport": value = "Virtual" as NSString
        default: return nil
        }
        return Unmanaged.passRetained(value).toOpaque()
    }

    private let hingeCopyEvent: HingeCopyEvent = { _, _, _, _, _, _ in nil }
    private let hingeSetOutputEvent: HingeSetOutputEvent = { _, _, _, _ in
        Int32(bitPattern: 0xE000_02C7)
    }

    private typealias CreateClient = @convention(c) (
        UnsafeRawPointer?, Int32, UnsafeRawPointer?
    )
        -> UnsafeMutableRawPointer?
    private typealias SetQueue = @convention(c) (
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?
    )
        -> Void
    private typealias Activate = @convention(c) (UnsafeMutableRawPointer?) -> Void
    private typealias CreateService = @convention(c) (
        UnsafeMutableRawPointer?, UnsafeRawPointer?, UnsafeRawPointer?,
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?
    )
        -> UnsafeMutableRawPointer?
    private typealias DispatchEvent = @convention(c) (
        UnsafeMutableRawPointer?, UnsafeMutableRawPointer?
    )
        -> Bool
    private typealias RemoveService = @convention(c) (UnsafeMutableRawPointer?) -> Bool
    private typealias CreateVendorEvent = @convention(c) (
        UnsafeRawPointer?, UInt64, UInt32, UInt32, UInt32,
        UnsafePointer<UInt8>?, CFIndex, UInt32
    )
        -> UnsafeMutableRawPointer?
    private typealias Serialize = @convention(c) (
        UnsafeRawPointer?, CFOptionFlags
    )
        -> UnsafeMutableRawPointer?

    private actor HingeService {
        static let shared = HingeService()

        private var handle: UnsafeMutableRawPointer?
        private var client: UnsafeMutableRawPointer?
        private var service: UnsafeMutableRawPointer?
        private var removeServiceFunction: RemoveService?
        private var callbacks: UnsafeMutablePointer<HingeCallbacks>?
        private var queue: DispatchQueue?
        private var settled = false

        // Singleton retains its IOKit handle, HID client, virtual service, and callbacks for the runner's lifetime.

        private func symbol<T>(_ name: String, as type: T.Type) throws -> T {
            guard let handle, let address = dlsym(handle, name) else {
                throw HingeAngleError.symbolUnavailable(name)
            }
            return unsafeBitCast(address, to: type)
        }

        private func start() throws {
            guard service == nil else { return }
            if handle == nil {
                guard let opened = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW) else {
                    throw HingeAngleError.symbolUnavailable("IOKit.framework")
                }
                handle = opened
            }
            let createClient = try symbol("IOHIDEventSystemClientCreateWithType", as: CreateClient.self)
            let setQueue = try symbol("IOHIDEventSystemClientSetDispatchQueue", as: SetQueue.self)
            let activate = try symbol("IOHIDEventSystemClientActivate", as: Activate.self)
            let createService = try symbol("IOHIDVirtualServiceClientCreate", as: CreateService.self)
            _ = try symbol("IOHIDVirtualServiceClientDispatchEvent", as: DispatchEvent.self)
            removeServiceFunction = try symbol("IOHIDVirtualServiceClientRemove", as: RemoveService.self)
            _ = try symbol("IOHIDEventCreateVendorDefinedEvent", as: CreateVendorEvent.self)
            _ = try symbol("IOCFSerialize", as: Serialize.self)

            if let client {
                Unmanaged<CFTypeRef>.fromOpaque(client).release()
                self.client = nil
            }
            guard let createdClient = createClient(nil, 2, nil) else {
                throw HingeAngleError.serviceCreationFailed
            }
            client = createdClient
            let dispatchQueue = DispatchQueue(label: "com.automobile.ctrlproxy.hinge")
            queue = dispatchQueue
            setQueue(createdClient, Unmanaged.passUnretained(dispatchQueue).toOpaque())
            activate(createdClient)

            let properties = NSMutableDictionary(dictionary: [
                "PrimaryUsagePage": 0xFF61,
                "PrimaryUsage": 0x5B,
                "DeviceUsagePairs": [["DeviceUsagePage": 0xFF61, "DeviceUsage": 0x5B]],
                "Product": "AutoMobile CtrlProxy Hinge",
                "Transport": "Virtual",
            ])
            if callbacks == nil {
                let pointer = UnsafeMutablePointer<HingeCallbacks>.allocate(capacity: 1)
                pointer.initialize(to: HingeCallbacks(
                    notify: hingeNotify,
                    setProperty: hingeSetProperty,
                    copyProperty: hingeCopyProperty,
                    copyEvent: hingeCopyEvent,
                    setOutputEvent: hingeSetOutputEvent
                ))
                callbacks = pointer
            }
            let propertiesPointer = Unmanaged.passUnretained(properties).toOpaque()
            service = createService(
                createdClient,
                propertiesPointer,
                callbacks.map(UnsafeRawPointer.init),
                nil,
                nil
            )
            withExtendedLifetime(properties) {}
            guard service != nil else {
                Unmanaged<CFTypeRef>.fromOpaque(createdClient).release()
                client = nil
                throw HingeAngleError.serviceCreationFailed
            }
        }

        func setHingeAngle(_ degrees: Double) async throws {
            try start()
            if !settled {
                // The event system needs time to match the newly registered virtual service.
                try await Task.sleep(for: .milliseconds(500))
                settled = true
            }

            let payload = NSDictionary(dictionary: [
                "source": "hinge-slider-control",
                "type": "range",
                "value": NSNumber(value: degrees),
            ])
            let serialize = try symbol("IOCFSerialize", as: Serialize.self)
            let payloadPointer = Unmanaged.passUnretained(payload).toOpaque()
            let dataPointer = serialize(payloadPointer, 0)
            withExtendedLifetime(payload) {}
            guard let dataPointer else {
                throw HingeAngleError.dispatchFailed
            }
            let data = Unmanaged<CFData>.fromOpaque(dataPointer).takeRetainedValue()
            let length = CFDataGetLength(data)
            guard length <= 256 else { throw HingeAngleError.payloadTooLarge(length) }

            let createEvent = try symbol("IOHIDEventCreateVendorDefinedEvent", as: CreateVendorEvent.self)
            let dataBytes = CFDataGetBytePtr(data)
            let event = createEvent(
                nil, mach_absolute_time(), 0xFF61, 0x5B, 0,
                dataBytes, length, 0
            )
            withExtendedLifetime(data) {}
            guard let event else {
                throw HingeAngleError.dispatchFailed
            }
            defer { Unmanaged<CFTypeRef>.fromOpaque(event).release() }
            let dispatch = try symbol("IOHIDVirtualServiceClientDispatchEvent", as: DispatchEvent.self)
            guard dispatch(service, event) else {
                tearDownAfterDispatchFailure()
                throw HingeAngleError.dispatchFailed
            }
        }

        private func tearDownAfterDispatchFailure() {
            if let service {
                if let removeServiceFunction {
                    _ = removeServiceFunction(service)
                }
                Unmanaged<CFTypeRef>.fromOpaque(service).release()
                self.service = nil
            }
            if let client {
                Unmanaged<CFTypeRef>.fromOpaque(client).release()
                self.client = nil
            }
            settled = false
        }
    }
#endif

public struct DefaultHingeAngleSetter: HingeAngleSetting {
    public init() {}

    public func setHingeAngle(_ degrees: Double) async throws {
        #if os(iOS) && targetEnvironment(simulator)
            try await HingeService.shared.setHingeAngle(degrees)
        #else
            throw HingeAngleError.unsupportedPlatform
        #endif
    }
}
