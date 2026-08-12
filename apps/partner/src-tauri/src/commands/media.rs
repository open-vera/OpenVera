//! Read binary media (images) as data URLs for the preview panel.
//!
//! `fs::read_to_string` cannot carry a PNG, and enabling Tauri's asset protocol
//! would need a static path scope — which conflicts with Partner opening any
//! directory at runtime. Encoding here keeps the existing host-dispatch surface
//! and the workspace model intact.

use std::fs;
use std::path::Path;

use serde::Serialize;

/// Data URLs travel through JSON IPC and inflate ~33% when encoded, so cap the
/// source file rather than locking up the webview on a huge asset.
const MAX_MEDIA_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileView {
    pub path: String,
    pub mime_type: String,
    pub data_url: String,
    pub bytes: u64,
}

pub fn read_file_data_url(path: String) -> Result<MediaFileView, String> {
    let target = Path::new(&path);
    let size = fs::metadata(target)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_MEDIA_BYTES {
        return Err(format!(
            "file is {size} bytes; preview is limited to {MAX_MEDIA_BYTES} bytes"
        ));
    }

    let bytes = fs::read(target).map_err(|error| error.to_string())?;
    let mime_type = mime_for_path(target).to_string();
    let data_url = format!("data:{mime_type};base64,{}", base64_encode(&bytes));

    Ok(MediaFileView {
        path,
        mime_type,
        data_url,
        bytes: size,
    })
}

pub fn mime_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jpe" | "jfif" | "pjpeg" | "pjp" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tiff" | "tif" => "image/tiff",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding. Hand-rolled to avoid a new crate dependency
/// for twenty lines of encoding.
fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(BASE64_ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_root(label: &str) -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "partner-media-{label}-{}-{unique}",
            std::process::id()
        ));
        create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn base64_matches_the_rfc_test_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_encodes_high_bytes_without_sign_errors() {
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
        assert_eq!(base64_encode(&[0x00, 0x00, 0x00]), "AAAA");
        // PNG magic bytes.
        assert_eq!(base64_encode(&[0x89, 0x50, 0x4e, 0x47]), "iVBORw==");
    }

    #[test]
    fn mime_is_derived_from_the_extension() {
        assert_eq!(mime_for_path(Path::new("/a/b.PNG")), "image/png");
        assert_eq!(mime_for_path(Path::new("/a/b.jpg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("/a/b.jpeg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("/a/b.svg")), "image/svg+xml");
        assert_eq!(
            mime_for_path(Path::new("/a/b.unknownext")),
            "application/octet-stream"
        );
        assert_eq!(
            mime_for_path(Path::new("/a/noextension")),
            "application/octet-stream"
        );
    }

    #[test]
    fn reads_a_file_into_a_data_url() {
        let root = temp_root("read");
        let path = root.join("pixel.png");
        write(&path, [0x89, 0x50, 0x4e, 0x47]).expect("write");

        let view = read_file_data_url(path.to_string_lossy().to_string()).expect("view");
        assert_eq!(view.mime_type, "image/png");
        assert_eq!(view.bytes, 4);
        assert_eq!(view.data_url, "data:image/png;base64,iVBORw==");
    }

    #[test]
    fn rejects_a_file_over_the_size_cap() {
        let root = temp_root("huge");
        let path = root.join("big.png");
        write(&path, vec![0u8; (MAX_MEDIA_BYTES + 1) as usize]).expect("write");

        let error =
            read_file_data_url(path.to_string_lossy().to_string()).expect_err("should refuse");
        assert!(error.contains("limited to"));
    }

    #[test]
    fn reports_a_missing_file_as_an_error() {
        let root = temp_root("missing");
        let error = read_file_data_url(root.join("nope.png").to_string_lossy().to_string())
            .expect_err("should fail");
        assert!(!error.is_empty());
    }
}
