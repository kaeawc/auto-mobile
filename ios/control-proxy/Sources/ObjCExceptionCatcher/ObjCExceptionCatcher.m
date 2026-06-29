#import "ObjCExceptionCatcher.h"

NSException * _Nullable ObjCExceptionCatcher_tryBlock(void (NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return nil;
    }
    @catch (NSException *exception) {
        return exception;
    }
}

BOOL ObjCExceptionCatcher_synthesizeMultiFingerSwipe(
    CGFloat startX,
    CGFloat startY,
    CGFloat endX,
    CGFloat endY,
    NSInteger fingerCount,
    CGFloat fingerSpacing,
    NSTimeInterval duration,
    NSInteger interfaceOrientation,
    NSString *_Nullable *_Nullable errorMessage
) {
#if TARGET_OS_IOS
    __block BOOL success = NO;
    __block NSString *failure = nil;

    NSException *exception = ObjCExceptionCatcher_tryBlock(^{
        Class pathClass = NSClassFromString(@"XCPointerEventPath");
        Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");

        if (pathClass == Nil || recordClass == Nil) {
            failure = @"XCTest private multi-touch event synthesis classes are unavailable";
            return;
        }
        if (![pathClass instancesRespondToSelector:@selector(initForTouchAtPoint:offset:)] ||
            ![pathClass instancesRespondToSelector:@selector(moveToPoint:atOffset:)] ||
            ![pathClass instancesRespondToSelector:@selector(liftUpAtOffset:)]) {
            failure = @"XCPointerEventPath does not support the expected multi-touch selectors";
            return;
        }
        if (![recordClass instancesRespondToSelector:@selector(initWithName:interfaceOrientation:)] ||
            ![recordClass instancesRespondToSelector:@selector(addPointerEventPath:)] ||
            ![recordClass instancesRespondToSelector:@selector(synthesizeWithError:)]) {
            failure = @"XCSynthesizedEventRecord does not support the expected synthesis selectors";
            return;
        }

        XCSynthesizedEventRecord *record = [[recordClass alloc]
            initWithName:@"AutoMobile multi-finger swipe"
            interfaceOrientation:(UIInterfaceOrientation)interfaceOrientation
        ];
        NSInteger resolvedFingerCount = fingerCount > 1 ? fingerCount : 1;
        NSTimeInterval liftOffset = duration > 0.05 ? duration : 0.05;

        for (NSInteger index = 0; index < resolvedFingerCount; index++) {
            CGFloat dx = (CGFloat)index * fingerSpacing;
            XCPointerEventPath *path = [[pathClass alloc]
                initForTouchAtPoint:CGPointMake(startX + dx, startY)
                offset:0
            ];
            [path moveToPoint:CGPointMake(endX + dx, endY) atOffset:duration];
            [path liftUpAtOffset:liftOffset];
            [record addPointerEventPath:path];
        }

        NSError *synthesisError = nil;
        success = [record synthesizeWithError:&synthesisError];
        if (!success) {
            NSString *description = synthesisError.localizedDescription != nil ? synthesisError.localizedDescription : @"unknown error";
            failure = [NSString stringWithFormat:@"multi-finger swipe synthesis failed: %@",
                       description];
        }
    });

    if (exception != nil) {
        NSString *reason = exception.reason != nil ? exception.reason : @"no reason";
        failure = [NSString stringWithFormat:@"Objective-C exception during multi-finger swipe synthesis: %@ - %@",
                   exception.name, reason];
    }
    if (!success && errorMessage != NULL) {
        *errorMessage = failure != nil ? failure : @"multi-finger swipe synthesis failed";
    }

    return success;
#else
    if (errorMessage != NULL) {
        *errorMessage = @"XCTest private multi-touch event synthesis is only available on iOS";
    }
    return NO;
#endif
}
