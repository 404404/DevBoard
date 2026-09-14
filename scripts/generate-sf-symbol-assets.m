#import <AppKit/AppKit.h>

static BOOL WriteSymbol(NSString *name, NSString *outputDirectory) {
  NSImage *image = [NSImage imageWithSystemSymbolName:name accessibilityDescription:nil];
  if (image == nil) {
    fprintf(stderr, "Unknown SF Symbol: %s\n", [name UTF8String]);
    return NO;
  }

  NSImageSymbolConfiguration *configuration =
      [NSImageSymbolConfiguration configurationWithPointSize:20
                                                       weight:NSFontWeightRegular
                                                        scale:NSImageSymbolScaleMedium];
  image = [image imageWithSymbolConfiguration:configuration];

  const NSInteger pixels = 60;
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:NULL
                    pixelsWide:pixels
                    pixelsHigh:pixels
                 bitsPerSample:8
               samplesPerPixel:4
                      hasAlpha:YES
                      isPlanar:NO
                colorSpaceName:NSCalibratedRGBColorSpace
                   bytesPerRow:0
                  bitsPerPixel:0];
  [bitmap setSize:NSMakeSize(20, 20)];

  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
  [NSGraphicsContext setCurrentContext:context];
  [[NSColor clearColor] setFill];
  NSRectFill(NSMakeRect(0, 0, 20, 20));

  NSSize imageSize = image.size;
  CGFloat scale = MIN(20.0 / imageSize.width, 20.0 / imageSize.height);
  NSSize targetSize = NSMakeSize(imageSize.width * scale, imageSize.height * scale);
  NSRect targetRect = NSMakeRect((20.0 - targetSize.width) / 2.0,
                                 (20.0 - targetSize.height) / 2.0,
                                 targetSize.width,
                                 targetSize.height);
  [image drawInRect:targetRect
           fromRect:NSZeroRect
          operation:NSCompositingOperationSourceOver
           fraction:1.0
     respectFlipped:NO
              hints:nil];
  [context flushGraphics];
  [NSGraphicsContext restoreGraphicsState];

  NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  NSString *path = [outputDirectory stringByAppendingPathComponent:
      [name stringByAppendingPathExtension:@"png"]];
  return [png writeToFile:path atomically:YES];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(stderr, "Usage: %s OUTPUT_DIRECTORY SYMBOL...\n", argv[0]);
      return 64;
    }

    NSString *outputDirectory = [NSString stringWithUTF8String:argv[1]];
    BOOL success = YES;
    for (int index = 2; index < argc; index += 1) {
      NSString *name = [NSString stringWithUTF8String:argv[index]];
      success = WriteSymbol(name, outputDirectory) && success;
    }
    return success ? 0 : 1;
  }
}
