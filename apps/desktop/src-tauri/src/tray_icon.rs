use tauri::image::Image;

/// Keep mint accents while removing the light background from the menu icon.
/// Average premultiplied colors so transparent pixels don't tint small edges.
pub fn menu_icon(source: &Image<'_>) -> Image<'static> {
    let size = 36u32;
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let mut coverage = 0u64;
            let mut color = [0u64; 3];
            let mut count = 0u64;
            for sy in (y * source.height() / size)..((y + 1) * source.height() / size) {
                for sx in (x * source.width() / size)..((x + 1) * source.width() / size) {
                    let i = ((sy * source.width() + sx) * 4) as usize;
                    let p = &source.rgba()[i..i + 4];
                    let mint = p[1] as u16 > p[0] as u16 + 12 && p[1] as u16 > p[2] as u16 + 4;
                    let light = *p[..3].iter().max().unwrap() as u32;
                    let mask = if mint {
                        255
                    } else {
                        (160u32.saturating_sub(light) * 255 / 128).min(255)
                    };
                    let alpha = (mask * p[3] as u32 / 255) as u64;
                    coverage += alpha;
                    for channel in 0..3 {
                        color[channel] += p[channel] as u64 * alpha;
                    }
                    count += 1;
                }
            }
            let i = ((y * size + x) * 4) as usize;
            if coverage > 0 {
                for channel in 0..3 {
                    pixels[i + channel] = (color[channel] / coverage) as u8;
                }
                pixels[i + 3] = (coverage / count) as u8;
            }
        }
    }
    Image::new_owned(pixels, size, size)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_mint_and_dark_marks_but_clears_white_and_transparent_pixels() {
        for (color, expected) in [
            ([255, 255, 255, 255], [0, 0, 0, 0]),
            ([140, 220, 185, 255], [140, 220, 185, 255]),
            ([25, 25, 25, 255], [25, 25, 25, 255]),
            ([140, 220, 185, 0], [0, 0, 0, 0]),
        ] {
            let source = Image::new_owned(color.repeat(36 * 36), 36, 36);
            let output = menu_icon(&source);
            assert!(output.rgba().chunks_exact(4).all(|p| p == expected));
        }
    }
    #[test]
    fn downsampling_does_not_mix_white_into_mint_edges() {
        let mut pixels = [255, 255, 255, 255].repeat(72 * 72);
        pixels[..4].copy_from_slice(&[140, 220, 185, 255]);
        let source = Image::new_owned(pixels, 72, 72);
        let output = menu_icon(&source);
        assert_eq!(&output.rgba()[..4], &[140, 220, 185, 63]);
    }
}
