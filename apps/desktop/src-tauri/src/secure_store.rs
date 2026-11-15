//! The desktop refresh token in the OS keychain (architecture §13 and §14, ADR 009), through the
//! `keyring` crate: Keychain Services on macOS, Credential Manager on Windows and the Secret Service
//! on Linux. Values go back to the webview and nowhere else: this module never logs them and never
//! puts them in an error message.

use serde::Deserialize;
use tauri::{AppHandle, Runtime};

/// The keys the webview may use. Any other key fails to deserialise, so Tauri rejects the call
/// before it reaches the keychain.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecureKey {
    RefreshToken,
}

impl SecureKey {
    /// The keychain account name: the same string the webview sends.
    fn account(self) -> &'static str {
        match self {
            Self::RefreshToken => "refresh_token",
        }
    }
}

/// Returns the stored value, or `None` when nothing is stored.
#[tauri::command]
pub async fn secure_store_get<R: Runtime>(
    app: AppHandle<R>,
    key: SecureKey,
) -> Result<Option<String>, String> {
    with_entry(&app, key, |entry| match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error),
    })
    .await
}

/// Stores `value`, replacing any previous one.
#[tauri::command]
pub async fn secure_store_set<R: Runtime>(
    app: AppHandle<R>,
    key: SecureKey,
    value: String,
) -> Result<(), String> {
    with_entry(&app, key, move |entry| entry.set_password(&value)).await
}

/// Deletes the stored value. Deleting a value that is not there succeeds.
#[tauri::command]
pub async fn secure_store_delete<R: Runtime>(
    app: AppHandle<R>,
    key: SecureKey,
) -> Result<(), String> {
    with_entry(&app, key, |entry| match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    })
    .await
}

/// Runs a keychain operation on a blocking thread: the stores can block (macOS may show a keychain
/// prompt, the Secret Service is a D-Bus round trip) and must not stall the async runtime.
async fn with_entry<R, T, F>(app: &AppHandle<R>, key: SecureKey, operation: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(keyring::Entry) -> keyring::Result<T> + Send + 'static,
{
    // The bundle identifier is the keychain service name, so entries are easy to find and audit.
    let service = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        keyring::Entry::new(&service, key.account()).and_then(operation)
    })
    .await
    .map_err(|_| "the keychain task stopped unexpectedly".to_owned())?
    .map_err(|error| describe(&error))
}

/// Turns a keychain error into a message for the webview.
fn describe(error: &keyring::Error) -> String {
    match error {
        // Both carry the raw stored bytes, so they are never formatted.
        keyring::Error::BadEncoding(_) | keyring::Error::BadDataFormat(..) => {
            "the stored value is not readable".to_owned()
        }
        other => format!("system keychain error: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::SecureKey;

    #[test]
    fn accepts_only_the_refresh_token_key() {
        let key: SecureKey = serde_json::from_str(r#""refresh_token""#).unwrap();
        assert_eq!(key, SecureKey::RefreshToken);
        for other in [
            r#""access_token""#,
            r#""RefreshToken""#,
            r#""""#,
            "null",
            "1",
        ] {
            assert!(
                serde_json::from_str::<SecureKey>(other).is_err(),
                "{other} was accepted"
            );
        }
    }

    #[test]
    fn account_is_the_key_the_webview_sends() {
        assert_eq!(SecureKey::RefreshToken.account(), "refresh_token");
    }

    #[test]
    fn errors_with_stored_bytes_are_not_formatted() {
        let error = keyring::Error::BadEncoding(b"secret".to_vec());
        assert!(!super::describe(&error).contains("secret"));
    }
}
