#import <AppKit/AppKit.h>

// A dedicated 22pt glyph, drawn at the display's native scale.
static void DrawMonochrome(CGContextRef ctx, NSColor *foreground) {
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, 3, 1);
    CGContextScaleCTM(ctx, 16.0 / 358.0, 16.0 / 358.0);
    CGContextTranslateCTM(ctx, -179, -179);
    CGMutablePathRef path = CGPathCreateMutable();
    #include "knot-path.inc"
    CGContextSetFillColorWithColor(ctx, foreground.CGColor);
    CGContextAddPath(ctx, path);
    CGContextEOFillPath(ctx);
    CGPathRelease(path);
    CGContextRestoreGState(ctx);

    // Keep cards apart, with only the essential marks visible at menu-bar size.
    CGContextSetLineWidth(ctx, 1.1);
    CGContextSetLineCap(ctx, kCGLineCapRound);
    CGContextSetLineJoin(ctx, kCGLineJoinRound);
    CGContextSetStrokeColorWithColor(ctx, foreground.CGColor);
    for (int side = 0; side < 2; side++) {
        CGFloat x = side == 0 ? 1.0 : 15.5;
        CGPathRef card = CGPathCreateWithRoundedRect(CGRectMake(x, 16, 5.5, 5), 0.8, 0.8, NULL);
        CGContextAddPath(ctx, card);
        CGContextStrokePath(ctx);
        CGPathRelease(card);
        CGContextMoveToPoint(ctx, x + 1.5, 18.5);
        CGContextAddLineToPoint(ctx, x + 4, 18.5);
        CGContextStrokePath(ctx);
    }
}

static void DrawAccent(CGContextRef ctx) {
    CGContextSetLineWidth(ctx, 1.1);
    CGContextSetLineCap(ctx, kCGLineCapRound);
    CGContextSetLineJoin(ctx, kCGLineJoinRound);
    CGPathRef center = CGPathCreateWithRoundedRect(CGRectMake(7.75, 15, 6.5, 6.5), 1.2, 1.2, NULL);
    CGContextSetFillColorWithColor(ctx, [NSColor colorWithSRGBRed:0.56 green:0.87 blue:0.73 alpha:1].CGColor);
    CGContextAddPath(ctx, center);
    CGContextFillPath(ctx);
    CGPathRelease(center);
    CGContextSetStrokeColorWithColor(ctx, [NSColor colorWithSRGBRed:0.10 green:0.22 blue:0.18 alpha:1].CGColor);
    CGContextMoveToPoint(ctx, 9.25, 18.3);
    CGContextAddLineToPoint(ctx, 10.5, 19.5);
    CGContextAddLineToPoint(ctx, 12.8, 17.2);
    CGContextStrokePath(ctx);
}

@interface CodexBoardMenuGlyph : NSView
@end
@implementation CodexBoardMenuGlyph
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (NSView *)hitTest:(NSPoint)point { return nil; } // The status button owns all clicks.
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
}
- (void)viewDidChangeBackingProperties {
    [super viewDidChangeBackingProperties];
    self.needsDisplay = YES;
}
- (void)drawRect:(NSRect)dirtyRect {
    CGContextRef ctx = NSGraphicsContext.currentContext.CGContext;
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, round((self.bounds.size.width - 22) / 2), round((self.bounds.size.height - 22) / 2));
    DrawAccent(ctx);
    CGContextRestoreGState(ctx);
}
@end

void codexboard_install_menu_glyph(void *pointer) {
    NSCAssert(NSThread.isMainThread, @"Menu glyph must be installed on the main thread");
    NSStatusItem *item = (__bridge NSStatusItem *)pointer;
    NSStatusBarButton *button = item.button;
    if (!button) return;
    item.length = 30;
    NSImage *image = [NSImage imageWithSize:NSMakeSize(22, 22) flipped:YES drawingHandler:^BOOL(NSRect rect) {
        DrawMonochrome(NSGraphicsContext.currentContext.CGContext, NSColor.blackColor);
        return YES;
    }];
    image.template = YES;
    button.image = image;
    button.imagePosition = NSImageOnly;
    button.imageScaling = NSImageScaleNone;
    button.accessibilityLabel = @"CodexBoard";
    CodexBoardMenuGlyph *view = [[CodexBoardMenuGlyph alloc] initWithFrame:button.bounds];
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [view setAccessibilityElement:NO];
    [button addSubview:view];
}

#ifdef CODEXBOARD_ICON_PREVIEW
int main(int argc, char **argv) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSStatusItem *probe = [NSStatusBar.systemStatusBar statusItemWithLength:30];
        codexboard_install_menu_glyph((__bridge void *)probe);
        NSCAssert(probe.button.image.isTemplate, @"System must control monochrome tint");
        NSCAssert(NSEqualSizes(probe.button.image.size, NSMakeSize(22, 22)), @"Use 22pt canvas");
        NSView *overlay = probe.button.subviews.lastObject;
        NSCAssert([overlay isKindOfClass:CodexBoardMenuGlyph.class], @"Mint overlay is installed");
        NSCAssert([overlay hitTest:NSMakePoint(11,11)] == nil, @"Overlay cannot consume menu clicks");
        [NSStatusBar.systemStatusBar removeStatusItem:probe];
        for (int dark = 0; dark < 2; dark++) {
            for (int scale = 1; scale <= 2; scale++) {
                int size = 22 * scale;
                NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:size pixelsHigh:size bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
                NSGraphicsContext *graphics = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
                [NSGraphicsContext saveGraphicsState];
                NSGraphicsContext.currentContext = graphics;
                CGContextRef ctx = graphics.CGContext;
                CGContextTranslateCTM(ctx, 0, size);
                CGContextScaleCTM(ctx, scale, -scale);
                NSAppearance *appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
                [appearance performAsCurrentDrawingAppearance:^{ DrawMonochrome(ctx, NSColor.labelColor); DrawAccent(ctx); }];
                [NSGraphicsContext restoreGraphicsState];
                NSUInteger mintPixels = 0, neutralPixels = 0, clearPixels = 0;
                for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
                    NSColor *pixel = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
                    if (pixel.alphaComponent < 0.01) { clearPixels++; continue; }
                    if (pixel.greenComponent > pixel.redComponent + 0.1) { mintPixels++; continue; }
                    if (pixel.alphaComponent > 0.6 && fabs(pixel.redComponent - pixel.greenComponent) < 0.03) {
                        NSCAssert(dark ? pixel.redComponent > 0.8 : pixel.redComponent < 0.3, @"Foreground follows appearance");
                        neutralPixels++;
                    }
                }
                fprintf(stderr, "appearance=%d scale=%d mint=%lu neutral=%lu clear=%lu\n", dark, scale, mintPixels, neutralPixels, clearPixels);
                NSCAssert(mintPixels > 0 && neutralPixels > 0 && clearPixels > size * size / 4, @"Preserve mint, foreground and transparent margin");
                NSString *file = [NSString stringWithFormat:@"%s/%s-%dx.png", argv[1], dark ? "dark" : "light", scale];
                [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:file atomically:YES];
            }
        }
    }
    return 0;
}
#endif
