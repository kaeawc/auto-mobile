// Simulator-only proof of concept. Uses public selectors and Objective-C runtime APIs.
// No hooks are installed unless a poster can be loaded. This is a process-wide fake
// video pipeline, not a complete AVFoundation device implementation.
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <objc/runtime.h>
#import <math.h>

static const size_t AMWidth = 1080, AMHeight = 1440;
static CGImageRef AMOriginalImage, AMPosterImage;
static CVPixelBufferRef AMPixels;
static CMVideoFormatDescriptionRef AMFormat;
static NSData *AMPNG;
static AVCaptureDevice *AMDevice;
static NSArray<AVMetadataObject *> *AMCodes;
static Class AMDiscoveryClass, AMInputClass, AMCodeClass, AMPhotoClass, AMResolvedClass, AMConnectionClass;
static char AMStateKey, AMOutputKey, AMSessionKey, AMTypesKey, AMDeviceKey, AMResolvedKey, AMMessageKey, AMIDKey;

@interface AMOutputState : NSObject
@property(nonatomic, weak) id delegate;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, weak) AVCaptureSession *session;
// One fake connection per output, reused for every frame: fake instances are never freed.
@property(nonatomic, strong) AVCaptureConnection *connection;
@end
@implementation AMOutputState
@end

@interface AMSessionState : NSObject
@property(nonatomic) BOOL running;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) NSUInteger frame;
@property(nonatomic, copy) NSString *preset;
@property(nonatomic, strong) NSMutableArray *inputs;
@property(nonatomic, strong) NSMutableArray<AVCaptureOutput *> *outputs;
@property(nonatomic, strong) NSHashTable<AVCaptureVideoPreviewLayer *> *layers;
@property(nonatomic, strong) dispatch_source_t timer;
@end
@implementation AMSessionState
- (instancetype)init {
    if ((self = [super init])) {
        _inputs = [NSMutableArray array];
        _outputs = [NSMutableArray array];
        _layers = [NSHashTable weakObjectsHashTable];
        _preset = AVCaptureSessionPresetPhoto;
    }
    return self;
}
- (void)dealloc { if (_timer) dispatch_source_cancel(_timer); }
@end

static id AMAssociated(id object, const void *key, Class type) {
    @synchronized (object) {
        id value = objc_getAssociatedObject(object, key);
        if (!value) {
            value = [type new];
            objc_setAssociatedObject(object, key, value, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        return value;
    }
}
static AMSessionState *AMState(id session) { return AMAssociated(session, &AMStateKey, AMSessionState.class); }
static AMOutputState *AMOutput(id output) { return AMAssociated(output, &AMOutputKey, AMOutputState.class); }
static void AMStore(id object, const void *key, id value) {
    objc_setAssociatedObject(object, key, value, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
// class_replaceMethod adds an override when the public method is inherited;
// exchanging an inherited Method would accidentally change its superclass.
static void AMReplace(Class type, SEL selector, id block) {
    Method method = class_getInstanceMethod(type, selector);
    NSCAssert(method, @"Missing public method %@", NSStringFromSelector(selector));
    class_replaceMethod(type, selector, imp_implementationWithBlock(block), method_getTypeEncoding(method));
}
static Class AMSubclass(Class parent, const char *name) {
    Class type = objc_allocateClassPair(parent, name, 0);
    objc_registerClassPair(type);
    // Instances come from class_createInstance without the parent's init, so the parent's dealloc
    // would tear down state that was never built. Leak them instead (a few small objects per run).
    class_replaceMethod(type, sel_registerName("dealloc"), imp_implementationWithBlock(^(__unsafe_unretained id o) {}), "v@:");
    return type;
}
static BOOL AMVideo(AVMediaType media) { return [media isEqualToString:AVMediaTypeVideo]; }
static BOOL AMMatches(NSArray *types, AVMediaType media) {
    return AMVideo(media) && [types containsObject:AVCaptureDeviceTypeBuiltInWideAngleCamera];
}

// Core Image applies source orientation, then aspect-fills a deterministic canvas.
// Retain the original separately. PNG permits decoded-pixel comparisons without
// JPEG loss; its encoded bytes/hash need not match the original source file.
// Core Image also avoids adding CoreGraphics/QuartzCore link flags to the build.
static BOOL AMLoadPoster(NSString *path, NSString *qr) {
    CIContext *context = [CIContext contextWithOptions:nil];
    CIImage *source;
    BOOL generated = !path.length;
    if (!generated) {
        source = [CIImage imageWithContentsOfURL:[NSURL fileURLWithPath:path]
                                       options:@{kCIImageApplyOrientationProperty: @YES}];
    } else {
        CIFilter *filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
        [filter setValue:[qr dataUsingEncoding:NSUTF8StringEncoding] forKey:@"inputMessage"];
        [filter setValue:@"M" forKey:@"inputCorrectionLevel"];
        CIImage *code = filter.outputImage;
        if (!code) return NO;
        // Integer scaling to approximately 640 px, with four white quiet modules.
        CGFloat modules = code.extent.size.width;
        CGFloat scale = MAX(1, floor(640 / (modules + 8)));
        CGFloat side = (modules + 8) * scale;
        CIImage *white = [[CIImage imageWithColor:[CIColor colorWithRed:1 green:1 blue:1]]
            imageByCroppingToRect:CGRectMake(0, 0, side, side)];
        code = [[code imageBySamplingNearest] imageByApplyingTransform:
            (CGAffineTransform){scale, 0, 0, scale, 4 * scale, 4 * scale}];
        source = [code imageByCompositingOverImage:white];
    }
    CGRect extent = source.extent;
    if (!source || !isfinite(extent.size.width) || !isfinite(extent.size.height) ||
        extent.size.width <= 0 || extent.size.height <= 0) return NO;
    AMOriginalImage = [context createCGImage:source fromRect:extent];
    if (!AMOriginalImage) return NO;
    CGFloat sx = (CGFloat)AMWidth / extent.size.width, sy = (CGFloat)AMHeight / extent.size.height;
    // Generated square QR gets white portrait padding to preserve its quiet zone;
    // file posters use aspect-fill and may crop a QR placed near their edges.
    CGFloat scale = generated ? MIN(sx, sy) : MAX(sx, sy);
    CGFloat x = (AMWidth - extent.size.width * scale) / 2 - extent.origin.x * scale;
    CGFloat y = (AMHeight - extent.size.height * scale) / 2 - extent.origin.y * scale;
    if (generated) source = [source imageBySamplingNearest];
    CIImage *scaled = [source imageByApplyingTransform:(CGAffineTransform){scale, 0, 0, scale, x, y}];
    CGRect canvas = CGRectMake(0, 0, AMWidth, AMHeight);
    CIImage *white = [[CIImage imageWithColor:[CIColor colorWithRed:1 green:1 blue:1]] imageByCroppingToRect:canvas];
    CIImage *poster = [[scaled imageByCompositingOverImage:white] imageByCroppingToRect:canvas];
    AMPosterImage = [context createCGImage:poster fromRect:canvas];
    if (!AMPosterImage) return NO;
    AMPNG = UIImagePNGRepresentation([UIImage imageWithCGImage:AMPosterImage]);
    NSDictionary *attrs = @{(id)kCVPixelBufferCGImageCompatibilityKey: @YES,
                             (id)kCVPixelBufferIOSurfacePropertiesKey: @{}};
    if (CVPixelBufferCreate(kCFAllocatorDefault, AMWidth, AMHeight, kCVPixelFormatType_32BGRA,
                           (__bridge CFDictionaryRef)attrs, &AMPixels) != kCVReturnSuccess) return NO;
    [context render:[CIImage imageWithCGImage:AMPosterImage] toCVPixelBuffer:AMPixels bounds:canvas colorSpace:nil];
    return AMPNG && CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, AMPixels, &AMFormat) == noErr;
}

// init-family replacements need actual init-family ARC ownership conventions.
@interface AVCaptureDeviceInput (AMPoster)
- (instancetype)am_initWithDevice:(AVCaptureDevice *)device error:(NSError **)error __attribute__((objc_method_family(init)));
@end
@implementation AVCaptureDeviceInput (AMPoster)
- (instancetype)am_initWithDevice:(AVCaptureDevice *)device error:(NSError **)error {
    if (device != AMDevice) return [self am_initWithDevice:device error:error];
    self = (id)class_createInstance(AMInputClass, 0);
    if (error) *error = nil;
    AMStore(self, &AMDeviceKey, device);
    return self;
}
@end

static void AMBindLayer(AVCaptureVideoPreviewLayer *layer, AVCaptureSession *session) {
    AVCaptureSession *old = objc_getAssociatedObject(layer, &AMSessionKey);
    if (old) { AMSessionState *s = AMState(old); @synchronized (s) { [s.layers removeObject:layer]; } }
    AMStore(layer, &AMSessionKey, session);
    if (session) { AMSessionState *s = AMState(session); @synchronized (s) { [s.layers addObject:layer]; } }
    layer.contents = session && session.isRunning ? (__bridge id)AMPosterImage : nil;
    // Public CALayer string values avoid a separate QuartzCore link dependency.
    layer.contentsScale = 1;
    layer.minificationFilter = @"nearest"; layer.magnificationFilter = @"nearest";
}
@interface AVCaptureVideoPreviewLayer (AMPoster)
- (instancetype)am_initWithSession:(AVCaptureSession *)session __attribute__((objc_method_family(init)));
@end
@implementation AVCaptureVideoPreviewLayer (AMPoster)
- (instancetype)am_initWithSession:(AVCaptureSession *)session {
    // After the exchange, am_initWithSession: is the stock implementation: run it with no session so
    // AVFoundation's private layer state is initialised, then bind the poster session ourselves.
    self = [self am_initWithSession:nil];
    if (self) {
        self.videoGravity = AVLayerVideoGravityResizeAspect;
        AMBindLayer(self, session);
    }
    return self;
}
@end

static void AMExchange(Class cls, SEL original, SEL replacement) {
    method_exchangeImplementations(class_getInstanceMethod(cls, original), class_getInstanceMethod(cls, replacement));
}
static void AMInstallObjects(void) {
    Class device = AMSubclass(AVCaptureDevice.class, "AMPosterDevice");
    AMReplace(device, @selector(uniqueID), ^id(id o) { return @"AMCameraPoster.back"; });
    AMReplace(device, @selector(localizedName), ^id(id o) { return @"AutoMobile Poster Camera"; });
    AMReplace(device, @selector(position), ^AVCaptureDevicePosition(id o) { return AVCaptureDevicePositionBack; });
    AMReplace(device, @selector(deviceType), ^id(id o) { return AVCaptureDeviceTypeBuiltInWideAngleCamera; });
    AMReplace(device, @selector(hasMediaType:), ^BOOL(id o, AVMediaType media) { return AMVideo(media); });
    AMReplace(device, @selector(isConnected), ^BOOL(id o) { return YES; });
    AMReplace(device, @selector(formats), ^id(id o) { return @[]; });
    AMReplace(device, @selector(activeFormat), ^id(id o) { return nil; });
    AMDevice = (id)class_createInstance(device, 0);
    AMDiscoveryClass = AMSubclass(AVCaptureDeviceDiscoverySession.class, "AMPosterDiscovery");
    AMReplace(AMDiscoveryClass, @selector(devices), ^id(id o) { return @[AMDevice]; });
    AMReplace(AMDiscoveryClass, @selector(supportedMultiCamDeviceSets), ^id(id o) { return @[]; });
    AMInputClass = AMSubclass(AVCaptureDeviceInput.class, "AMPosterInput");
    AMReplace(AMInputClass, @selector(device), ^id(id o) { return objc_getAssociatedObject(o, &AMDeviceKey); });
    AMReplace(AMInputClass, @selector(ports), ^id(id o) { return @[]; });
    AMConnectionClass = AMSubclass(AVCaptureConnection.class, "AMPosterConnection");
    AMReplace(AMConnectionClass, @selector(isEnabled), ^BOOL(id o) { return YES; });
    AMReplace(AMConnectionClass, @selector(isActive), ^BOOL(id o) { return YES; });
    AMReplace(AMConnectionClass, @selector(inputPorts), ^id(id o) { return @[]; });
    AMReplace(AMConnectionClass, @selector(output), ^id(id o) { return objc_getAssociatedObject(o, &AMOutputKey); });
    AMCodeClass = AMSubclass(AVMetadataMachineReadableCodeObject.class, "AMPosterCode");
    AMReplace(AMCodeClass, @selector(stringValue), ^id(id o) { return objc_getAssociatedObject(o, &AMMessageKey); });
    AMReplace(AMCodeClass, @selector(type), ^id(id o) { return AVMetadataObjectTypeQRCode; });
    AMReplace(AMCodeClass, @selector(bounds), ^CGRect(id o) { return CGRectMake(0.1, 0.1, 0.8, 0.8); });
    AMReplace(AMCodeClass, @selector(corners), ^id(id o) {
        return @[@{@"X": @0.1, @"Y": @0.1}, @{@"X": @0.9, @"Y": @0.1},
                 @{@"X": @0.9, @"Y": @0.9}, @{@"X": @0.1, @"Y": @0.9}];
    });
    AMReplace(AMCodeClass, @selector(time), ^CMTime(id o) { return CMClockGetTime(CMClockGetHostTimeClock()); });
    AMReplace(AMCodeClass, @selector(duration), ^CMTime(id o) { return CMTimeMake(1, 2); });
    AMResolvedClass = AMSubclass(AVCaptureResolvedPhotoSettings.class, "AMPosterResolvedSettings");
    AMReplace(AMResolvedClass, @selector(uniqueID), ^int64_t(id o) { return [objc_getAssociatedObject(o, &AMIDKey) longLongValue]; });
    AMReplace(AMResolvedClass, @selector(photoDimensions), ^CMVideoDimensions(id o) { return (CMVideoDimensions){AMWidth, AMHeight}; });
    AMReplace(AMResolvedClass, @selector(expectedPhotoCount), ^NSInteger(id o) { return 1; });
    AMPhotoClass = AMSubclass(AVCapturePhoto.class, "AMPosterPhoto");
    AMReplace(AMPhotoClass, @selector(fileDataRepresentation), ^id(id o) { return AMPNG; });
    AMReplace(AMPhotoClass, @selector(CGImageRepresentation), ^CGImageRef(id o) { return AMPosterImage; });
    AMReplace(AMPhotoClass, @selector(pixelBuffer), ^CVPixelBufferRef(id o) { return AMPixels; });
    AMReplace(AMPhotoClass, @selector(metadata), ^id(id o) { return @{@"PixelWidth": @(AMWidth), @"PixelHeight": @(AMHeight)}; });
    AMReplace(AMPhotoClass, @selector(resolvedSettings), ^id(id o) { return objc_getAssociatedObject(o, &AMResolvedKey); });
    AMReplace(AMPhotoClass, @selector(photoCount), ^NSInteger(id o) { return 1; });
    AMReplace(AMPhotoClass, @selector(timestamp), ^CMTime(id o) { return CMClockGetTime(CMClockGetHostTimeClock()); });
    AMReplace(AMPhotoClass, @selector(isRawPhoto), ^BOOL(id o) { return NO; });
    // Decode once; generated QR also goes through detection rather than echoing env.
    CIDetector *detector = [CIDetector detectorOfType:CIDetectorTypeQRCode context:nil
                                           options:@{CIDetectorAccuracy: CIDetectorAccuracyHigh}];
    NSMutableArray *codes = [NSMutableArray array];
    for (CIQRCodeFeature *feature in [detector featuresInImage:[CIImage imageWithCGImage:AMPosterImage]]) {
        if (!feature.messageString) continue;
        id code = class_createInstance(AMCodeClass, 0);
        AMStore(code, &AMMessageKey, feature.messageString);
        [codes addObject:code];
    }
    AMCodes = [codes copy];
}

static void AMInstallDiscovery(void) {
    Class cls = object_getClass(AVCaptureDevice.class);
    IMP original = class_getMethodImplementation(cls, @selector(defaultDeviceWithMediaType:));
    AMReplace(cls, @selector(defaultDeviceWithMediaType:), ^id(id o, AVMediaType media) {
        return AMVideo(media) ? AMDevice : ((id (*)(id, SEL, id))original)(o, @selector(defaultDeviceWithMediaType:), media);
    });
    IMP devices = class_getMethodImplementation(cls, @selector(devicesWithMediaType:));
    AMReplace(cls, @selector(devicesWithMediaType:), ^id(id o, AVMediaType media) {
        return AMVideo(media) ? @[AMDevice] : ((id (*)(id, SEL, id))devices)(o, @selector(devicesWithMediaType:), media);
    });
    IMP typed = class_getMethodImplementation(cls, @selector(defaultDeviceWithDeviceType:mediaType:position:));
    AMReplace(cls, @selector(defaultDeviceWithDeviceType:mediaType:position:),
        ^id(id o, AVCaptureDeviceType type, AVMediaType media, AVCaptureDevicePosition position) {
            if (AMVideo(media)) return [type isEqual:AVCaptureDeviceTypeBuiltInWideAngleCamera] ? AMDevice : nil;
            return ((id (*)(id, SEL, id, id, AVCaptureDevicePosition))typed)
                (o, @selector(defaultDeviceWithDeviceType:mediaType:position:), type, media, position);
        });
    IMP auth = class_getMethodImplementation(cls, @selector(authorizationStatusForMediaType:));
    AMReplace(cls, @selector(authorizationStatusForMediaType:), ^AVAuthorizationStatus(id o, AVMediaType media) {
        return AMVideo(media) ? AVAuthorizationStatusAuthorized :
            ((AVAuthorizationStatus (*)(id, SEL, id))auth)(o, @selector(authorizationStatusForMediaType:), media);
    });
    IMP access = class_getMethodImplementation(cls, @selector(requestAccessForMediaType:completionHandler:));
    AMReplace(cls, @selector(requestAccessForMediaType:completionHandler:), ^(id o, AVMediaType media, void (^handler)(BOOL)) {
        if (AMVideo(media)) { if (handler) dispatch_async(dispatch_get_main_queue(), ^{ handler(YES); }); }
        else ((void (*)(id, SEL, id, id))access)(o, @selector(requestAccessForMediaType:completionHandler:), media, handler);
    });
    Class discovery = object_getClass(AVCaptureDeviceDiscoverySession.class);
    IMP factory = class_getMethodImplementation(discovery, @selector(discoverySessionWithDeviceTypes:mediaType:position:));
    AMReplace(discovery, @selector(discoverySessionWithDeviceTypes:mediaType:position:),
        ^id(id o, NSArray *types, AVMediaType media, AVCaptureDevicePosition position) {
            if (AMMatches(types, media)) return class_createInstance(AMDiscoveryClass, 0);
            return ((id (*)(id, SEL, id, id, AVCaptureDevicePosition))factory)
                (o, @selector(discoverySessionWithDeviceTypes:mediaType:position:), types, media, position);
        });
    AMExchange(AVCaptureDeviceInput.class, @selector(initWithDevice:error:), @selector(am_initWithDevice:error:));
    AMReplace(object_getClass(AVCaptureDeviceInput.class), @selector(deviceInputWithDevice:error:),
        ^id(id o, AVCaptureDevice *device, NSError **error) { return [[AVCaptureDeviceInput alloc] initWithDevice:device error:error]; });
}

static BOOL AMCurrent(AMSessionState *s, NSUInteger generation) {
    @synchronized (s) { return s.running && s.generation == generation; }
}
static void AMTick(AVCaptureSession *session, NSUInteger generation) {
    AMSessionState *s = AMState(session);
    NSArray *outputs, *layers;
    BOOL metadataTick;
    @synchronized (s) {
        if (!s.running || s.generation != generation) return;
        outputs = [s.outputs copy]; layers = s.layers.allObjects;
        metadataTick = (s.frame++ % 8 == 0); // 8/15 s, approximately 500 ms.
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!AMCurrent(s, generation)) return;
        for (AVCaptureVideoPreviewLayer *layer in layers)
            if (layer.session == session) layer.contents = (__bridge id)AMPosterImage;
    });
    for (AVCaptureOutput *output in outputs) {
        AMOutputState *binding = AMOutput(output);
        id delegate; dispatch_queue_t queue; AVCaptureConnection *connection;
        @synchronized (binding) {
            delegate = binding.delegate; queue = binding.queue;
            if (delegate && queue && !binding.connection) {
                binding.connection = class_createInstance(AMConnectionClass, 0);
                AMStore(binding.connection, &AMOutputKey, output);
            }
            connection = binding.connection;
        }
        if (!delegate || !queue) continue;
        if ([output isKindOfClass:AVCaptureVideoDataOutput.class] &&
            [delegate respondsToSelector:@selector(captureOutput:didOutputSampleBuffer:fromConnection:)]) {
            CMSampleTimingInfo timing = {CMTimeMake(1, 15), CMClockGetTime(CMClockGetHostTimeClock()), kCMTimeInvalid};
            CMSampleBufferRef sample = NULL;
            if (CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, AMPixels, AMFormat, &timing, &sample) != noErr) continue;
            dispatch_async(queue, ^{
                if (AMCurrent(s, generation) && binding.session == session)
                    [delegate captureOutput:output didOutputSampleBuffer:sample fromConnection:connection];
                CFRelease(sample);
            });
        } else if (metadataTick && AMCodes.count && [output isKindOfClass:AVCaptureMetadataOutput.class] &&
                   [delegate respondsToSelector:@selector(captureOutput:didOutputMetadataObjects:fromConnection:)]) {
            dispatch_async(queue, ^{
                NSArray *types = objc_getAssociatedObject(output, &AMTypesKey);
                if (AMCurrent(s, generation) && binding.session == session && [types containsObject:AVMetadataObjectTypeQRCode])
                    [delegate captureOutput:(AVCaptureMetadataOutput *)output didOutputMetadataObjects:AMCodes fromConnection:connection];
            });
        }
    }
}
static void AMInstallSession(void) {
    Class cls = AVCaptureSession.class;
    AMReplace(cls, @selector(canAddInput:), ^BOOL(id o, AVCaptureInput *input) { return input != nil; });
    AMReplace(cls, @selector(addInput:), ^(id o, AVCaptureInput *input) {
        AMSessionState *s = AMState(o); @synchronized (s) { if (input && ![s.inputs containsObject:input]) [s.inputs addObject:input]; }
    });
    AMReplace(cls, @selector(removeInput:), ^(id o, AVCaptureInput *input) {
        AMSessionState *s = AMState(o); @synchronized (s) { [s.inputs removeObject:input]; }
    });
    AMReplace(cls, @selector(inputs), ^id(id o) { AMSessionState *s = AMState(o); @synchronized (s) { return [s.inputs copy]; } });
    AMReplace(cls, @selector(canAddOutput:), ^BOOL(id o, AVCaptureOutput *output) { return output != nil; });
    AMReplace(cls, @selector(addOutput:), ^(AVCaptureSession *o, AVCaptureOutput *output) {
        AMSessionState *s = AMState(o); @synchronized (s) {
            if (output && ![s.outputs containsObject:output]) { [s.outputs addObject:output]; AMOutput(output).session = o; }
        }
    });
    AMReplace(cls, @selector(removeOutput:), ^(id o, AVCaptureOutput *output) {
        AMSessionState *s = AMState(o); @synchronized (s) { [s.outputs removeObject:output]; AMOutput(output).session = nil; }
    });
    AMReplace(cls, @selector(outputs), ^id(id o) { AMSessionState *s = AMState(o); @synchronized (s) { return [s.outputs copy]; } });
    AMReplace(cls, @selector(beginConfiguration), ^(id o) {});
    AMReplace(cls, @selector(commitConfiguration), ^(id o) {});
    AMReplace(cls, @selector(setSessionPreset:), ^(id o, NSString *preset) {
        AMSessionState *s = AMState(o); @synchronized (s) { s.preset = preset; }
    });
    AMReplace(cls, @selector(sessionPreset), ^id(id o) { AMSessionState *s = AMState(o); @synchronized (s) { return s.preset; } });
    AMReplace(cls, @selector(canSetSessionPreset:), ^BOOL(id o, NSString *preset) { return YES; });
    AMReplace(cls, @selector(isRunning), ^BOOL(id o) { AMSessionState *s = AMState(o); @synchronized (s) { return s.running; } });
    AMReplace(cls, @selector(isInterrupted), ^BOOL(id o) { return NO; });
    AMReplace(cls, @selector(startRunning), ^(AVCaptureSession *o) {
        AMSessionState *s = AMState(o); @synchronized (s) {
            if (s.running) return;
            s.running = YES; s.frame = 0;
            NSUInteger generation = ++s.generation;
            __weak AVCaptureSession *weakSession = o;
            s.timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                dispatch_queue_create("dev.automobile.camera-poster.frames", DISPATCH_QUEUE_SERIAL));
            dispatch_source_set_timer(s.timer, DISPATCH_TIME_NOW, NSEC_PER_SEC / 15, NSEC_PER_MSEC * 3);
            dispatch_source_set_event_handler(s.timer, ^{
                @autoreleasepool { AVCaptureSession *session = weakSession; if (session) AMTick(session, generation); }
            });
            dispatch_resume(s.timer);
        }
    });
    AMReplace(cls, @selector(stopRunning), ^(AVCaptureSession *o) {
        AMSessionState *s = AMState(o); NSArray *layers;
        @synchronized (s) {
            s.running = NO; ++s.generation;
            if (s.timer) dispatch_source_cancel(s.timer);
            s.timer = nil; layers = s.layers.allObjects;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            for (AVCaptureVideoPreviewLayer *layer in layers)
                if (layer.session == o && !o.isRunning) layer.contents = nil;
        });
    });
}

static void AMInstallPreviewAndOutputs(void) {
    Class layer = AVCaptureVideoPreviewLayer.class;
    AMExchange(layer, @selector(initWithSession:), @selector(am_initWithSession:));
    AMReplace(object_getClass(layer), @selector(layerWithSession:), ^id(id o, AVCaptureSession *s) {
        return [[AVCaptureVideoPreviewLayer alloc] initWithSession:s];
    });
    AMReplace(layer, @selector(setSession:), ^(AVCaptureVideoPreviewLayer *o, AVCaptureSession *s) { AMBindLayer(o, s); });
    AMReplace(layer, @selector(session), ^id(id o) { return objc_getAssociatedObject(o, &AMSessionKey); });
    AMReplace(layer, @selector(setVideoGravity:), ^(AVCaptureVideoPreviewLayer *o, AVLayerVideoGravity gravity) {
        o.contentsGravity = [gravity isEqual:AVLayerVideoGravityResizeAspectFill] ? @"resizeAspectFill" :
            ([gravity isEqual:AVLayerVideoGravityResize] ? @"resize" : @"resizeAspect");
    });
    AMReplace(layer, @selector(videoGravity), ^id(AVCaptureVideoPreviewLayer *o) {
        return [o.contentsGravity isEqual:@"resizeAspectFill"] ? AVLayerVideoGravityResizeAspectFill :
            ([o.contentsGravity isEqual:@"resize"] ? AVLayerVideoGravityResize : AVLayerVideoGravityResizeAspect);
    });
    AMReplace(AVCaptureVideoDataOutput.class, @selector(setSampleBufferDelegate:queue:),
        ^(id o, id delegate, dispatch_queue_t queue) {
            AMOutputState *s = AMOutput(o); @synchronized (s) { s.delegate = delegate; s.queue = queue; }
        });
    AMReplace(AVCaptureMetadataOutput.class, @selector(setMetadataObjectsDelegate:queue:),
        ^(id o, id delegate, dispatch_queue_t queue) {
            AMOutputState *s = AMOutput(o); @synchronized (s) { s.delegate = delegate; s.queue = queue; }
        });
    AMReplace(AVCaptureMetadataOutput.class, @selector(setMetadataObjectTypes:), ^(id o, NSArray *types) { AMStore(o, &AMTypesKey, [types copy]); });
    AMReplace(AVCaptureMetadataOutput.class, @selector(metadataObjectTypes), ^id(id o) { return objc_getAssociatedObject(o, &AMTypesKey) ?: @[]; });
    AMReplace(AVCaptureMetadataOutput.class, @selector(availableMetadataObjectTypes), ^id(id o) { return @[AVMetadataObjectTypeQRCode]; });
    AMReplace(AVCapturePhotoOutput.class, @selector(connectionWithMediaType:), ^id(id o, AVMediaType type) { return nil; });
    AMReplace(AVCapturePhotoOutput.class, @selector(capturePhotoWithSettings:delegate:),
        ^(AVCapturePhotoOutput *o, AVCapturePhotoSettings *settings, id<AVCapturePhotoCaptureDelegate> delegate) {
            id resolved = class_createInstance(AMResolvedClass, 0);
            AMStore(resolved, &AMIDKey, @(settings.uniqueID));
            id photo = class_createInstance(AMPhotoClass, 0);
            AMStore(photo, &AMResolvedKey, resolved);
            AVCaptureSession *session = AMOutput(o).session;
            NSError *error = session.isRunning ? nil : [NSError errorWithDomain:@"AMCameraPoster" code:1
                userInfo:@{NSLocalizedDescriptionKey: @"Capture session is not running"}];
            dispatch_async(dispatch_get_main_queue(), ^{
                if ([delegate respondsToSelector:@selector(captureOutput:willBeginCaptureForResolvedSettings:)])
                    [delegate captureOutput:o willBeginCaptureForResolvedSettings:resolved];
                if ([delegate respondsToSelector:@selector(captureOutput:didFinishProcessingPhoto:error:)])
                    [delegate captureOutput:o didFinishProcessingPhoto:photo error:error];
                if ([delegate respondsToSelector:@selector(captureOutput:didFinishCaptureForResolvedSettings:error:)])
                    [delegate captureOutput:o didFinishCaptureForResolvedSettings:resolved error:error];
            });
        });
}

__attribute__((constructor)) static void AMActivate(void) {
    @autoreleasepool {
        NSDictionary *env = NSProcessInfo.processInfo.environment;
        NSString *path = env[@"AM_CAMERA_POSTER_PATH"], *qr = env[@"AM_CAMERA_POSTER_QR"];
        if (!path.length && !qr.length) return;
        if (!AMLoadPoster(path, qr)) return; // Invalid path wins too: no QR fallback.
        AMInstallObjects(); AMInstallDiscovery(); AMInstallSession(); AMInstallPreviewAndOutputs();
        Class picker = object_getClass(UIImagePickerController.class);
        IMP available = class_getMethodImplementation(picker, @selector(isSourceTypeAvailable:));
        AMReplace(picker, @selector(isSourceTypeAvailable:), ^BOOL(id o, UIImagePickerControllerSourceType type) {
            return type == UIImagePickerControllerSourceTypeCamera ||
                ((BOOL (*)(id, SEL, UIImagePickerControllerSourceType))available)(o, @selector(isSourceTypeAvailable:), type);
        });
        IMP media = class_getMethodImplementation(picker, @selector(availableMediaTypesForSourceType:));
        AMReplace(picker, @selector(availableMediaTypesForSourceType:), ^id(id o, UIImagePickerControllerSourceType type) {
            return type == UIImagePickerControllerSourceTypeCamera ? @[UTTypeImage.identifier] :
                ((id (*)(id, SEL, UIImagePickerControllerSourceType))media)(o, @selector(availableMediaTypesForSourceType:), type);
        });
        AMReplace(picker, @selector(isCameraDeviceAvailable:), ^BOOL(id o, UIImagePickerControllerCameraDevice device) { return YES; });
        // Availability only: presenting/capturing with UIImagePickerController is
        // outside this PoC. VisionKit/DataScanner hardware gates are not patched.
        NSLog(@"[AMCameraPoster] active source=%@ size=%zux%zu", path.length ? @"path" : @"qr", AMWidth, AMHeight);
    }
}
