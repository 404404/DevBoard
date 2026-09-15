use std::{env, path::PathBuf, process::Command};
fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        let object = out.join("menu-bar-icon.o");
        let library = out.join("libcodexboard_menu_icon.a");
        assert!(
            Command::new("clang")
                .args([
                    "-fobjc-arc",
                    "-fmodules",
                    "-mmacosx-version-min=13.0",
                    "-c",
                    "../native/menu-bar-icon.m",
                    "-o"
                ])
                .arg(&object)
                .status()
                .unwrap()
                .success(),
            "menu bar glyph compilation failed"
        );
        assert!(Command::new("ar")
            .arg("rcs")
            .arg(&library)
            .arg(&object)
            .status()
            .unwrap()
            .success());
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static=codexboard_menu_icon");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rerun-if-changed=../native/menu-bar-icon.m");
        println!("cargo:rerun-if-changed=../native/knot-path.inc");
    }
    tauri_build::build()
}
