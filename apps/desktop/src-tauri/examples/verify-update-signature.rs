use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::{env, error::Error, fs};

fn decoded(path: &str) -> Result<String, Box<dyn Error>> {
    let text = fs::read_to_string(path)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(text.trim())?;
    Ok(String::from_utf8(bytes)?)
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        return Err("usage: verify-update-signature PUBLIC_KEY SIGNATURE ARCHIVE".into());
    }
    let public_key = PublicKey::decode(&decoded(&args[1])?)?;
    let signature = Signature::decode(&decoded(&args[2])?)?;
    let mut archive = fs::read(&args[3])?;
    // Match tauri-plugin-updater's verification, including its prehashed mode.
    public_key.verify(&archive, &signature, true)?;
    if archive.is_empty() {
        return Err("update archive is empty".into());
    }
    archive[0] ^= 1;
    if public_key.verify(&archive, &signature, true).is_ok() {
        return Err("tampered archive unexpectedly passed verification".into());
    }
    println!("更新签名有效；篡改包已被拒绝");
    Ok(())
}
