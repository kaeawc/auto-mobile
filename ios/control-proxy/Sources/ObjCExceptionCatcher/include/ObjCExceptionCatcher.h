#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <TargetConditionals.h>

#if TARGET_OS_IOS
#import <UIKit/UIKit.h>

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

NS_ASSUME_NONNULL_BEGIN

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

NS_ASSUME_NONNULL_END
