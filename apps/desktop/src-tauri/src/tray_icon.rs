use tauri::image::Image;

/// A template image uses only black and alpha; light fills become transparent.
/// Area sampling keeps the knot and cards legible at menu-bar resolution.
pub fn template(source: &Image<'_>) -> Image<'static> {
    let size = 36u32;
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let mut coverage = 0u64;
            let mut count = 0u64;
            for sy in (y * source.height() / size)..((y + 1) * source.height() / size) {
                for sx in (x * source.width() / size)..((x + 1) * source.width() / size) {
                    let i = ((sy * source.width() + sx) * 4) as usize;
                    let p = &source.rgba()[i..i + 4];
                    let light = *p[..3].iter().max().unwrap() as u32;
                    let alpha = (160u32.saturating_sub(light) * 255 / 128).min(255);
                    coverage += (alpha * p[3] as u32 / 255) as u64;
                    count += 1;
                }
            }
            if count > 0 {
                pixels[((y * size + x) * 4 + 3) as usize] = (coverage / count) as u8;
            }
        }
    }
    Image::new_owned(pixels, size, size)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn template_preserves_dark_marks_and_clears_all_background_fills() {
        for (color, expected) in [([255,255,255,255], 0), ([140,220,185,255], 0), ([25,25,25,255], 255), ([25,25,25,0], 0)] {
            let source = Image::new_owned(color.repeat(36 * 36), 36, 36);
            let output = template(&source);
            assert!(output.rgba().chunks_exact(4).all(|p| p == [0,0,0,expected]));
        }
    }
}
