#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#import <objc/runtime.h>

static NSString *displayIdentity(long long tag, int displayId) {
    NSString *kind;
    if (tag & 0x20) {
        kind = @"Car";
    } else if (tag & 0x40) {
        kind = @"CarInstruments";
    } else if (tag & 0x4) {
        kind = @"AirPlay";
    } else if (tag == 0) {
        kind = @"Untagged";
    } else {
        kind = [NSString stringWithFormat:@"Tag0x%llx", (unsigned long long)tag];
    }
    return [NSString stringWithFormat:@"%@[%d]", kind, displayId];
}

int main(void) {
    @autoreleasepool {
        Class displayClass = NSClassFromString(@"CADisplay");
        SEL displaysSelector = sel_registerName("displays");
        if (![displayClass respondsToSelector:displaysSelector]) {
            fprintf(stderr, "CADisplay displays is unavailable; check the simulator runtime.\n");
            return 1;
        }
        NSDictionary *state = @{
            @"found": @NO, @"tag": NSNull.null, @"displayId": NSNull.null,
            @"displayType": NSNull.null, @"identity": NSNull.null,
            @"isCarDisplay": @NO, @"isCarInstrumentsDisplay": @NO
        };
        NSArray *displays = ((id (*)(id, SEL))objc_msgSend)(displayClass, displaysSelector);
        for (id display in displays) {
            SEL nameSelector = sel_registerName("deviceName");
            if (![display respondsToSelector:nameSelector]) {
                fprintf(stderr, "CADisplay deviceName is unavailable.\n");
                return 1;
            }
            NSString *name = ((id (*)(id, SEL))objc_msgSend)(display, nameSelector);
            if (![name isEqualToString:@"wireless0"]) {
                continue;
            }
            SEL tagSelector = sel_registerName("tag");
            SEL typeSelector = sel_registerName("displayType");
            SEL idSelector = sel_registerName("displayId");
            if (![display respondsToSelector:tagSelector] ||
                ![display respondsToSelector:typeSelector] ||
                ![display respondsToSelector:idSelector]) {
                fprintf(stderr, "CADisplay tag, displayType or displayId is unavailable.\n");
                return 1;
            }
            // These scalar casts match the tag-only simulator probe. Never construct
            // FBSDisplayConfiguration: an attached, powered-off display can crash it.
            long long tag = ((long long (*)(id, SEL))objc_msgSend)(display, tagSelector);
            long long displayType = ((long long (*)(id, SEL))objc_msgSend)(display, typeSelector);
            int displayId = ((int (*)(id, SEL))objc_msgSend)(display, idSelector);
            state = @{
                @"found": @YES, @"tag": @(tag), @"displayId": @(displayId),
                @"displayType": @(displayType), @"identity": displayIdentity(tag, displayId),
                @"isCarDisplay": ((tag & 0x20) != 0) ? @YES : @NO,
                @"isCarInstrumentsDisplay": ((tag & 0x40) != 0) ? @YES : @NO
            };
            break;
        }
        NSError *error = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:state
                                                     options:NSJSONWritingSortedKeys
                                                       error:&error];
        if (!json) {
            fprintf(stderr, "Cannot encode projection state: %s\n", error.localizedDescription.UTF8String);
            return 1;
        }
        fwrite(json.bytes, 1, json.length, stdout);
        fputc('\n', stdout);
        return 0;
    }
}
