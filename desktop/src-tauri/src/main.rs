#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use aes_gcm::{aead::{Aead, KeyInit, OsRng}, Aes256Gcm, Nonce};
use aes_gcm::aead::rand_core::RngCore;
use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use once_cell::sync::Lazy;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

static LAST_HASH: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static SUPPRESS_NEXT: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardPayload { ciphertext: String, nonce: String, content_hash: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile { encrypted_metadata: String, bytes: Vec<u8> }

fn key_from_sync_key(sync_key: &str) -> [u8; 32] {
    let mut h = Sha256::new(); h.update(sync_key.as_bytes()); h.finalize().into()
}
fn encrypt_text(sync_key: &str, text: &str) -> Result<(String, String), String> {
    let key = key_from_sync_key(sync_key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12]; OsRng.fill_bytes(&mut nonce_bytes);
    let ct = cipher.encrypt(Nonce::from_slice(&nonce_bytes), text.as_bytes()).map_err(|e| e.to_string())?;
    Ok((STANDARD.encode(ct), STANDARD.encode(nonce_bytes)))
}
fn decrypt_text(sync_key: &str, ciphertext: &str, nonce: &str) -> Result<String, String> {
    let key = key_from_sync_key(sync_key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ct = STANDARD.decode(ciphertext).map_err(|e| e.to_string())?;
    let n = STANDARD.decode(nonce).map_err(|e| e.to_string())?;
    let pt = cipher.decrypt(Nonce::from_slice(&n), ct.as_ref()).map_err(|e| e.to_string())?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

#[tauri::command]
fn device_name() -> String { hostname::get().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|_| "Desktop".into()) }
#[tauri::command]
fn platform() -> String { std::env::consts::OS.to_string() }
#[tauri::command]
fn device_public_key() -> String { STANDARD.encode(Sha256::digest(format!("{}-{}", device_name(), std::env::consts::OS).as_bytes())) }

#[tauri::command]
fn poll_clipboard(sync_key: String) -> Result<Option<ClipboardPayload>, String> {
    if *SUPPRESS_NEXT.lock().unwrap() { *SUPPRESS_NEXT.lock().unwrap() = false; return Ok(None); }
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    let text = match cb.get_text() { Ok(t) if !t.is_empty() => t, _ => return Ok(None) };
    let hash = hex::encode(Sha256::digest(text.as_bytes()));
    let mut last = LAST_HASH.lock().unwrap();
    if last.as_deref() == Some(&hash) { return Ok(None); }
    *last = Some(hash.clone());
    let (ciphertext, nonce) = encrypt_text(&sync_key, &text)?;
    Ok(Some(ClipboardPayload{ciphertext, nonce, content_hash: hash}))
}

#[tauri::command]
fn apply_remote_clipboard(ciphertext: String, nonce: String, sync_key: String) -> Result<(), String> {
    let text = decrypt_text(&sync_key, &ciphertext, &nonce)?;
    let hash = hex::encode(Sha256::digest(text.as_bytes()));
    *LAST_HASH.lock().unwrap() = Some(hash);
    *SUPPRESS_NEXT.lock().unwrap() = true;
    Clipboard::new().map_err(|e| e.to_string())?.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
async fn encrypt_and_pick_file(app: tauri::AppHandle, sync_key: String) -> Result<Option<PickedFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    let file = app.dialog().file().blocking_pick_file();
    let Some(path) = file.and_then(|p| p.into_path().ok()) else { return Ok(None); };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let metadata = serde_json::json!({"name": path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), "size": bytes.len()}).to_string();
    let (encrypted_metadata, _) = encrypt_text(&sync_key, &metadata)?;
    Ok(Some(PickedFile{ encrypted_metadata, bytes }))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::with_id("main")
                .tooltip("剪贴板同步正在运行")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => { if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); } },
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event { if let Some(w)=tray.app_handle().get_webview_window("main") { let _=w.show(); let _=w.set_focus(); } })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![device_name, platform, device_public_key, poll_clipboard, apply_remote_clipboard, encrypt_and_pick_file])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}

