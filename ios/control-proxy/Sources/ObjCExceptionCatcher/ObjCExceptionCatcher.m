#import "ObjCExceptionCatcher.h"
#import <math.h>

ObjCPinchPoints ObjCExceptionCatcher_computePinchPoints(
    CGFloat centerX,
    CGFloat centerY,
    CGFloat distanceStart,
    CGFloat distanceEnd,
    CGFloat rotationDegrees
) {
    CGFloat startRadius = distanceStart / 2.0;
    CGFloat endRadius = distanceEnd / 2.0;
    // rotationDegrees rotates the finger axis *during* the pinch, NOT the orientation of a fixed
    // pinch axis: the fingers start on the horizontal axis (dyStart == 0) and move to an axis
    // rotated by rotationDegrees. A non-zero value therefore produces a combined pinch+rotate;
    // rotationDegrees == 0 (the common zoom case) keeps both axes horizontal. This matches the
    // Android runner's computePinchPoints so cross-platform results agree. See issues #2911/#2979.
    CGFloat endRadians = rotationDegrees * (CGFloat)M_PI / 180.0;
    CGFloat dxStart = startRadius;
    CGFloat dyStart = 0;
    CGFloat dxEnd = cos(endRadians) * endRadius;
    CGFloat dyEnd = sin(endRadians) * endRadius;

    ObjCPinchPoints points;
    points.start1 = CGPointMake(centerX - dxStart, centerY - dyStart);
    points.end1 = CGPointMake(centerX - dxEnd, centerY - dyEnd);
    points.start2 = CGPointMake(centerX + dxStart, centerY + dyStart);
    points.end2 = CGPointMake(centerX + dxEnd, centerY + dyEnd);
    return points;
}

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
    BOOL *_Nullable symbolsUnavailable,
    NSString *_Nullable *_Nullable errorMessage
) {
    // Default: symbols are assumed present until a guard proves otherwise, so a
    // genuine synthesis error is not misreported as an availability gap.
    if (symbolsUnavailable != NULL) {
        *symbolsUnavailable = NO;
    }
#if TARGET_OS_IOS
    __block BOOL success = NO;
    __block NSString *failure = nil;
    __block BOOL unavailable = NO;

    NSException *exception = ObjCExceptionCatcher_tryBlock(^{
        Class pathClass = NSClassFromString(@"XCPointerEventPath");
        Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");

        if (pathClass == Nil || recordClass == Nil) {
            unavailable = YES;
            failure = @"XCTest private multi-touch event synthesis classes are unavailable";
            return;
        }
        if (![pathClass instancesRespondToSelector:@selector(initForTouchAtPoint:offset:)] ||
            ![pathClass instancesRespondToSelector:@selector(moveToPoint:atOffset:)] ||
            ![pathClass instancesRespondToSelector:@selector(liftUpAtOffset:)]) {
            unavailable = YES;
            failure = @"XCPointerEventPath does not support the expected multi-touch selectors";
            return;
        }
        if (![recordClass instancesRespondToSelector:@selector(initWithName:interfaceOrientation:)] ||
            ![recordClass instancesRespondToSelector:@selector(addPointerEventPath:)] ||
            ![recordClass instancesRespondToSelector:@selector(synthesizeWithError:)]) {
            unavailable = YES;
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
        // A caught exception is a genuine synthesis failure, not an availability
        // gap, so leave `unavailable` as-is (NO unless a guard already set it).
        NSString *reason = exception.reason != nil ? exception.reason : @"no reason";
        failure = [NSString stringWithFormat:@"Objective-C exception during multi-finger swipe synthesis: %@ - %@",
                   exception.name, reason];
    }
    if (!success) {
        if (symbolsUnavailable != NULL) {
            *symbolsUnavailable = unavailable;
        }
        if (errorMessage != NULL) {
            *errorMessage = failure != nil ? failure : @"multi-finger swipe synthesis failed";
        }
    }

    return success;
#else
    // Off-iOS the private symbols are definitionally unavailable. There is no
    // public-API fallback for a multi-finger swipe, so this only selects the
    // availability-flavored failure message (see MultiFingerSwipeDiagnostics).
    if (symbolsUnavailable != NULL) {
        *symbolsUnavailable = YES;
    }
    if (errorMessage != NULL) {
        *errorMessage = @"XCTest private multi-touch event synthesis is only available on iOS";
    }
    return NO;
#endif
}

BOOL ObjCExceptionCatcher_synthesizePinch(
    CGFloat centerX,
    CGFloat centerY,
    CGFloat distanceStart,
    CGFloat distanceEnd,
    CGFloat rotationDegrees,
    NSTimeInterval duration,
    NSInteger interfaceOrientation,
    BOOL *_Nullable symbolsUnavailable,
    NSString *_Nullable *_Nullable errorMessage
) {
    // Default: symbols are assumed present until a guard proves otherwise, so a
    // genuine synthesis error is not misreported as an availability gap.
    if (symbolsUnavailable != NULL) {
        *symbolsUnavailable = NO;
    }
#if TARGET_OS_IOS
    __block BOOL success = NO;
    __block NSString *failure = nil;
    __block BOOL unavailable = NO;

    NSException *exception = ObjCExceptionCatcher_tryBlock(^{
        Class pathClass = NSClassFromString(@"XCPointerEventPath");
        Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");

        if (pathClass == Nil || recordClass == Nil) {
            unavailable = YES;
            failure = @"XCTest private pinch event synthesis classes are unavailable";
            return;
        }
        if (![pathClass instancesRespondToSelector:@selector(initForTouchAtPoint:offset:)] ||
            ![pathClass instancesRespondToSelector:@selector(moveToPoint:atOffset:)] ||
            ![pathClass instancesRespondToSelector:@selector(liftUpAtOffset:)]) {
            unavailable = YES;
            failure = @"XCPointerEventPath does not support the expected pinch selectors";
            return;
        }
        if (![recordClass instancesRespondToSelector:@selector(initWithName:interfaceOrientation:)] ||
            ![recordClass instancesRespondToSelector:@selector(addPointerEventPath:)] ||
            ![recordClass instancesRespondToSelector:@selector(synthesizeWithError:)]) {
            unavailable = YES;
            failure = @"XCSynthesizedEventRecord does not support the expected pinch synthesis selectors";
            return;
        }

        // Floor degenerate distances so a tiny/zero pinch still produces a non-collapsed radius.
        // The endpoint trig itself lives in the pure, unit-tested ObjCExceptionCatcher_computePinchPoints
        // (see PinchGeometryTests / issue #2979), which the Android computePinchPoints mirrors.
        CGFloat safeDistanceStart = distanceStart > 1 ? distanceStart : 1;
        CGFloat safeDistanceEnd = distanceEnd > 1 ? distanceEnd : 1;
        ObjCPinchPoints points = ObjCExceptionCatcher_computePinchPoints(
            centerX, centerY, safeDistanceStart, safeDistanceEnd, rotationDegrees);

        XCSynthesizedEventRecord *record = [[recordClass alloc]
            initWithName:@"AutoMobile pinch"
            interfaceOrientation:(UIInterfaceOrientation)interfaceOrientation
        ];
        NSTimeInterval liftOffset = duration > 0.05 ? duration : 0.05;

        XCPointerEventPath *firstPath = [[pathClass alloc]
            initForTouchAtPoint:points.start1
            offset:0
        ];
        [firstPath moveToPoint:points.end1 atOffset:duration];
        [firstPath liftUpAtOffset:liftOffset];
        [record addPointerEventPath:firstPath];

        XCPointerEventPath *secondPath = [[pathClass alloc]
            initForTouchAtPoint:points.start2
            offset:0
        ];
        [secondPath moveToPoint:points.end2 atOffset:duration];
        [secondPath liftUpAtOffset:liftOffset];
        [record addPointerEventPath:secondPath];

        NSError *synthesisError = nil;
        success = [record synthesizeWithError:&synthesisError];
        if (!success) {
            NSString *description = synthesisError.localizedDescription != nil ? synthesisError.localizedDescription : @"unknown error";
            failure = [NSString stringWithFormat:@"pinch synthesis failed: %@",
                       description];
        }
    });

    if (exception != nil) {
        // A caught exception is a genuine synthesis failure, not an availability
        // gap, so leave `unavailable` as-is (NO unless a guard already set it).
        NSString *reason = exception.reason != nil ? exception.reason : @"no reason";
        failure = [NSString stringWithFormat:@"Objective-C exception during pinch synthesis: %@ - %@",
                   exception.name, reason];
    }
    if (!success) {
        if (symbolsUnavailable != NULL) {
            *symbolsUnavailable = unavailable;
        }
        if (errorMessage != NULL) {
            *errorMessage = failure != nil ? failure : @"pinch synthesis failed";
        }
    }

    return success;
#else
    // Off-iOS the private symbols are definitionally unavailable, so signal the
    // caller to take the public-API fallback path.
    if (symbolsUnavailable != NULL) {
        *symbolsUnavailable = YES;
    }
    if (errorMessage != NULL) {
        *errorMessage = @"XCTest private pinch event synthesis is only available on iOS";
    }
    return NO;
#endif
}
