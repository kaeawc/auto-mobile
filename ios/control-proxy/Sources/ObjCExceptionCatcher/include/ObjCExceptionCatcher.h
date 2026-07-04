#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <TargetConditionals.h>

#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#endif

NS_ASSUME_NONNULL_BEGIN

#if TARGET_OS_IOS
/// Private XCTest touch synthesis declarations. These symbols are not documented
/// by Apple; callers must treat unavailability as a recoverable runtime error.
@interface XCPointerEventPath : NSObject
- (instancetype)initForTouchAtPoint:(CGPoint)point offset:(double)offset;
- (void)moveToPoint:(CGPoint)point atOffset:(double)offset;
- (void)liftUpAtOffset:(double)offset;
@end

@interface XCSynthesizedEventRecord : NSObject
- (instancetype)initWithName:(NSString *)name interfaceOrientation:(UIInterfaceOrientation)orientation;
- (void)addPointerEventPath:(XCPointerEventPath *)path;
- (BOOL)synthesizeWithError:(NSError **)error;
@end
#endif

/// The four touch endpoints of a two-finger pinch: two start points and two end points.
/// `start1`/`end1` are the center∓offset finger, `start2`/`end2` the center±offset finger.
typedef struct ObjCPinchPoints {
    CGPoint start1;
    CGPoint end1;
    CGPoint start2;
    CGPoint end2;
} ObjCPinchPoints;

/// Computes the two-finger pinch endpoints around (centerX, centerY).
///
/// Pure trig with no XCTest/UIKit dependency (available on all platforms, not just iOS) so it is
/// unit-testable off-device — see `PinchGeometryTests`. `synthesizePinch` calls this to build the
/// event paths, so the test guards the real synthesis math rather than a mirror of it.
///
/// `rotationDegrees` rotates the finger axis *during* the pinch, NOT the orientation of a fixed
/// pinch axis: the fingers start on the horizontal axis (start*.y == centerY) and move to an axis
/// rotated by `rotationDegrees`. A non-zero value therefore produces a combined pinch+rotate;
/// `rotationDegrees == 0` (the common zoom case) keeps both axes horizontal. Radii are
/// distance/2. This convention is shared with the Android runner's `computePinchPoints` so
/// cross-platform pinch results agree — see issues #2911 / #2979. This function does NOT clamp
/// degenerate distances; `synthesizePinch` applies its own minimum-distance floor before calling.
FOUNDATION_EXPORT ObjCPinchPoints ObjCExceptionCatcher_computePinchPoints(
    CGFloat centerX,
    CGFloat centerY,
    CGFloat distanceStart,
    CGFloat distanceEnd,
    CGFloat rotationDegrees
);

/// Executes the given block, catching any NSException thrown.
/// Returns the caught NSException, or nil if no exception was raised.
FOUNDATION_EXPORT NSException * _Nullable ObjCExceptionCatcher_tryBlock(void (NS_NOESCAPE ^block)(void));

/// Synthesizes a simultaneous multi-finger swipe through XCTest private event APIs.
/// Returns NO with a descriptive error message when the private symbols are unavailable
/// or synthesis fails. Objective-C exceptions are caught and reported through errorMessage.
FOUNDATION_EXPORT BOOL ObjCExceptionCatcher_synthesizeMultiFingerSwipe(
    CGFloat startX,
    CGFloat startY,
    CGFloat endX,
    CGFloat endY,
    NSInteger fingerCount,
    CGFloat fingerSpacing,
    NSTimeInterval duration,
    NSInteger interfaceOrientation,
    NSString *_Nullable *_Nullable errorMessage
);

/// Synthesizes a two-finger pinch through XCTest private event APIs.
/// Returns NO with a descriptive error message when the private symbols are unavailable
/// or synthesis fails. Objective-C exceptions are caught and reported through errorMessage.
///
/// `symbolsUnavailable` distinguishes the two failure modes so the caller can degrade
/// gracefully (see issue #2910): it is set to YES only when the required private
/// classes/selectors are missing (or the platform is not iOS), and left NO for a
/// genuine synthesis error or a caught Objective-C exception. When YES, the caller
/// should fall back to the public element-anchored `pinch(withScale:velocity:)`
/// rather than surfacing a hard failure.
FOUNDATION_EXPORT BOOL ObjCExceptionCatcher_synthesizePinch(
    CGFloat centerX,
    CGFloat centerY,
    CGFloat distanceStart,
    CGFloat distanceEnd,
    CGFloat rotationDegrees,
    NSTimeInterval duration,
    NSInteger interfaceOrientation,
    BOOL *_Nullable symbolsUnavailable,
    NSString *_Nullable *_Nullable errorMessage
);

NS_ASSUME_NONNULL_END
