use std::{path::Path, time::Duration};

use aes_gcm::{Aes256Gcm, KeyInit};
use reqwest::{header, redirect, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::modules::account_file_crypto::{
    decrypt_envelope, read_key, read_or_create_key_at, serialize_with_cipher, SecureAccountEnvelope,
};

const CONFIG_FIELD: &str = "newApiBalance";
const KEY_FILE: &str = "codex-new-api-balance.key";
const ENVELOPE_KIND: &str = "codex-new-api-balance";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BalanceConfig {
    origin: String,
    user_id: String,
    access_token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NewApiAccountBalance {
    pub(crate) amount: f64,
    pub(crate) unit: Option<String>,
}

fn normalized_endpoint(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| {
        format!("{}{}", url.origin().ascii_serialization(), url.path())
            .trim_end_matches('/')
            .to_lowercase()
    })
}

/// Resolve ownership before checking balance settings so duplicate endpoints
/// cannot select another provider's dashboard credentials.
pub(crate) fn find_account_provider<'a>(
    providers: &'a [Value],
    base_url: &str,
    api_key: Option<&str>,
    provider_id: Option<&str>,
) -> Option<&'a Value> {
    let endpoint = normalized_endpoint(base_url)?;
    let candidates: Vec<_> = providers
        .iter()
        .filter(|provider| {
            provider
                .get("baseUrl")
                .and_then(Value::as_str)
                .and_then(normalized_endpoint)
                .as_ref()
                == Some(&endpoint)
        })
        .collect();
    let named = provider_id.and_then(|id| {
        candidates
            .iter()
            .copied()
            .find(|provider| provider.get("id").and_then(Value::as_str) == Some(id.trim()))
    });
    let owners: Vec<_> = candidates
        .iter()
        .copied()
        .filter(|provider| {
            api_key
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .is_some_and(|key| {
                    provider
                        .get("apiKeys")
                        .and_then(Value::as_array)
                        .is_some_and(|keys| {
                            keys.iter().any(|item| {
                                item.get("apiKey").and_then(Value::as_str).map(str::trim)
                                    == Some(key)
                            })
                        })
                })
        })
        .collect();
    let provider = named
        .or_else(|| (owners.len() == 1).then(|| owners[0]))
        .or_else(|| (candidates.len() == 1).then(|| candidates[0]))?;
    provider
        .get(CONFIG_FIELD)
        .filter(|config| config.is_object())?;
    Some(provider)
}

pub(super) fn transform_provider_configs(
    dir: &Path,
    data: String,
    encrypt: bool,
) -> Result<String, String> {
    if !data.contains("\"newApiBalance\"") {
        return Ok(data);
    }
    let mut providers: Vec<Value> = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let key_path = dir.join(KEY_FILE);
    let mut configs = providers
        .iter_mut()
        .filter_map(|provider| provider.get_mut(CONFIG_FIELD))
        .filter(|config| config.is_object())
        .peekable();
    if configs.peek().is_none() {
        return Ok(data);
    }
    let key = if encrypt {
        Some(read_or_create_key_at(&key_path)?)
    } else {
        read_key(&key_path).ok()
    };
    let cipher = key.map(|key| Aes256Gcm::new((&key).into()));
    for config in configs {
        *config = if encrypt {
            let value: BalanceConfig = serde_json::from_value(config.clone())
                .map_err(|_| "PROVIDER_BALANCE_CONFIG_INVALID")?;
            let plain =
                serde_json::to_vec(&value).map_err(|_| "PROVIDER_BALANCE_CONFIG_INVALID")?;
            let encrypted = serialize_with_cipher(
                ENVELOPE_KIND,
                &plain,
                cipher.clone().ok_or("PROVIDER_BALANCE_CONFIG_INVALID")?,
            )?;
            serde_json::from_str(&encrypted).map_err(|_| "PROVIDER_BALANCE_CONFIG_INVALID")?
        } else {
            let envelope = serde_json::from_value::<SecureAccountEnvelope>(config.clone()).ok();
            let plain = envelope
                .filter(|envelope| envelope.kind == ENVELOPE_KIND)
                .zip(cipher.clone())
                .and_then(|(envelope, cipher)| {
                    decrypt_envelope::<BalanceConfig>(&envelope, cipher).ok()
                });
            serde_json::to_value(plain).map_err(|_| "PROVIDER_BALANCE_CONFIG_INVALID")?
        };
    }
    serde_json::to_string_pretty(&providers).map_err(|e| e.to_string())
}

fn dashboard_url(website: &str, configured_origin: &str) -> Result<Url, String> {
    let url = Url::parse(website.trim()).map_err(|_| "PROVIDER_BALANCE_CONFIG_INVALID")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.origin().ascii_serialization() != configured_origin
    {
        return Err("PROVIDER_BALANCE_CONFIG_INVALID".into());
    }
    Ok(url)
}

fn number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}

fn matches_account_id(account: &Value, user_id: &str) -> bool {
    account.get("public_id").and_then(Value::as_str) == Some(user_id)
        || match &account["id"] {
            Value::String(id) => id == user_id,
            Value::Number(id) => id.as_u64().is_some_and(|id| id.to_string() == user_id),
            _ => false,
        }
}

fn present_balance(quota: f64, status: &Value, dashboard: &Url) -> NewApiAccountBalance {
    let raw = NewApiAccountBalance {
        amount: quota,
        unit: None,
    };
    let setting = |key: &str| {
        status
            .get(key)
            .or_else(|| status.get("pricing_presentation")?.get(key))
    };
    let is_heju = dashboard
        .host_str()
        .is_some_and(|host| host == "hejuapi.com" || host.ends_with(".hejuapi.com"));
    // Heju uses 500,000 quota units per USD but omits the scale from /api/status.
    let scale = match setting("quota_per_unit") {
        Some(value) => number(Some(value)).filter(|n| *n > 0.0),
        None if is_heju => Some(500_000.0),
        None => None,
    };
    let Some(scale) = scale else {
        return raw;
    };
    let display = setting("quota_display_type")
        .and_then(Value::as_str)
        .or_else(|| (setting("display_in_currency")?.as_bool() == Some(true)).then_some("USD"))
        .or_else(|| is_heju.then_some("USD"));
    let (unit, rate) = match display {
        Some("USD") => ("USD", Some(1.0)),
        Some("CNY") => ("CNY", number(setting("usd_exchange_rate"))),
        Some("CUSTOM") => (
            setting("custom_currency_symbol")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim(),
            number(setting("custom_currency_exchange_rate")),
        ),
        _ => return raw,
    };
    let Some(rate) = rate.filter(|n| *n > 0.0) else {
        return raw;
    };
    let amount = quota / scale * rate;
    if unit.is_empty() || unit.chars().count() > 12 || !amount.is_finite() {
        return raw;
    }
    NewApiAccountBalance {
        amount,
        unit: Some(unit.to_owned()),
    }
}

async fn get_dashboard_data(
    client: &Client,
    url: Url,
    config: &BalanceConfig,
) -> Result<Value, String> {
    let response = client
        .get(url)
        .header(header::ACCEPT, "application/json")
        .header("New-Api-User", &config.user_id)
        .bearer_auth(&config.access_token)
        .send()
        .await
        .map_err(|_| "PROVIDER_BALANCE_NETWORK_FAILED")?;
    let status = response.status();
    if matches!(status.as_u16(), 401 | 403) {
        return Err("PROVIDER_BALANCE_AUTH_FAILED".into());
    }
    if !status.is_success() {
        return Err("PROVIDER_BALANCE_UNAVAILABLE".into());
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "PROVIDER_BALANCE_UNAVAILABLE")?;
    if body.get("success").and_then(Value::as_bool) == Some(false) {
        return Err("PROVIDER_BALANCE_AUTH_FAILED".into());
    }
    body.get("data")
        .cloned()
        .ok_or_else(|| "PROVIDER_BALANCE_UNAVAILABLE".into())
}

pub(super) async fn query(data: &str, provider_id: &str) -> Result<NewApiAccountBalance, String> {
    let providers: Vec<Value> =
        serde_json::from_str(data).map_err(|_| "PROVIDER_BALANCE_CONFIG_INVALID")?;
    let provider = providers
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(provider_id))
        .ok_or("PROVIDER_NOT_FOUND")?;
    let config: BalanceConfig =
        serde_json::from_value(provider.get(CONFIG_FIELD).cloned().unwrap_or_default())
            .map_err(|_| "PROVIDER_BALANCE_CONFIG_INVALID")?;
    if !(1..=128).contains(&config.user_id.len())
        || !config
            .user_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        || config.access_token.trim().is_empty()
    {
        return Err("PROVIDER_BALANCE_CONFIG_INVALID".into());
    }
    let url = dashboard_url(
        provider
            .get("website")
            .and_then(Value::as_str)
            .unwrap_or(""),
        &config.origin,
    )?;
    let account_url = url
        .join("/api/user/self")
        .map_err(|_| "PROVIDER_BALANCE_CONFIG_INVALID")?;
    let status_url = url
        .join("/api/status")
        .map_err(|_| "PROVIDER_BALANCE_CONFIG_INVALID")?;
    let client = Client::builder()
        .timeout(Duration::from_secs(
            super::CODEX_MODEL_PROVIDER_TEST_TIMEOUT_SECS,
        ))
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|_| "PROVIDER_BALANCE_NETWORK_FAILED")?;
    let (account, status) = tokio::join!(
        get_dashboard_data(&client, account_url, &config),
        get_dashboard_data(&client, status_url, &config)
    );
    let account = account?;
    if !matches_account_id(&account, &config.user_id) {
        return Err("PROVIDER_BALANCE_AUTH_FAILED".into());
    }
    let quota = number(account.get("quota")).ok_or("PROVIDER_BALANCE_UNAVAILABLE")?;
    Ok(present_balance(quota, &status.unwrap_or_default(), &url))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_public_ids_verbatim_and_legacy_numeric_ids() {
        let public_id = "0idAbC-123";
        assert!(matches_account_id(
            &json!({"id": 42, "public_id": public_id}),
            public_id
        ));
        assert!(matches_account_id(&json!({"id": public_id}), public_id));
        assert!(matches_account_id(&json!({"id": 42}), "42"));
        assert!(!matches_account_id(
            &json!({"id": 42, "public_id": public_id}),
            "0idabc-123"
        ));
        assert!(!matches_account_id(&json!({}), public_id));
    }

    #[test]
    fn account_balance_uses_provider_ownership_for_duplicate_urls() {
        let providers = json!([
            {"id":"a","baseUrl":"https://relay.example/v1","apiKeys":[{"apiKey":"key-a"}],"newApiBalance":{}},
            {"id":"b","baseUrl":"https://relay.example/v1/","apiKeys":[{"apiKey":"key-b"}],"newApiBalance":{}}
        ]);
        let providers = providers.as_array().unwrap();
        let resolve = |key, id| {
            find_account_provider(providers, "https://RELAY.example/v1", key, id)
                .and_then(|provider| provider["id"].as_str())
        };
        assert_eq!(resolve(Some("key-b"), Some("b")), Some("b"));
        assert_eq!(resolve(Some("key-b"), Some("legacy-preset")), Some("b"));
        assert_eq!(resolve(Some("key-b"), Some("a")), Some("a"));
        assert_eq!(resolve(None, None), None);
        assert_eq!(resolve(Some("unknown"), None), None);
        assert!(find_account_provider(
            providers,
            "https://other.example/v1",
            Some("key-b"),
            Some("b")
        )
        .is_none());
    }

    #[test]
    fn account_balance_never_borrows_another_providers_configuration() {
        let providers = json!([
            {"id":"a","baseUrl":"https://relay.example/v1","apiKeys":[{"apiKey":"shared"}]},
            {"id":"b","baseUrl":"https://relay.example/v1","apiKeys":[{"apiKey":"shared"}],"newApiBalance":{}}
        ]);
        let providers = providers.as_array().unwrap();
        assert!(find_account_provider(
            providers,
            "https://relay.example/v1",
            Some("shared"),
            Some("a")
        )
        .is_none());
        assert!(
            find_account_provider(providers, "https://relay.example/v1", Some("shared"), None)
                .is_none()
        );
        let only = &providers[1..];
        assert!(
            find_account_provider(only, "https://relay.example/v1/", Some("legacy-key"), None)
                .is_some()
        );
    }

    #[test]
    fn new_api_balance_config_is_encrypted_with_the_dashboard_origin() {
        let dir = tempfile::tempdir().unwrap();
        let raw = json!([{ "id": "provider", "website": "https://relay.example", "newApiBalance": {
            "origin": "https://relay.example", "userId": "42", "accessToken": "fixture-token"
        }}]);
        let protected = transform_provider_configs(dir.path(), raw.to_string(), true).unwrap();
        assert!(!protected.contains("fixture-token"));
        let restored = transform_provider_configs(dir.path(), protected, false).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&restored).unwrap(), raw);
        assert!(dashboard_url(
            "https://relay.example/console/personal",
            "https://relay.example"
        )
        .is_ok());
        assert!(dashboard_url("https://other.example", "https://relay.example").is_err());
        assert!(dashboard_url("http://relay.example", "https://relay.example").is_err());
    }

    #[test]
    fn new_api_balance_keeps_raw_quota_when_the_site_does_not_supply_conversion() {
        let dashboard = Url::parse("https://relay.example").unwrap();
        let raw = present_balance(1_250_000.0, &json!({}), &dashboard);
        assert_eq!(raw.amount, 1_250_000.0);
        assert_eq!(raw.unit, None);
        let cny = present_balance(
            1_250_000.0,
            &json!({
                "quota_per_unit": 500_000, "quota_display_type": "CNY", "usd_exchange_rate": 7.2
            }),
            &dashboard,
        );
        assert_eq!(cny.amount, 18.0);
        assert_eq!(cny.unit.as_deref(), Some("CNY"));
    }

    #[test]
    fn heju_balance_converts_raw_quota_when_status_omits_the_scale() {
        for website in [
            "https://www.hejuapi.com",
            "https://hejuapi.com",
            "https://us.hejuapi.com",
            "https://cdn.hejuapi.com",
            "https://ai.hejuapi.com",
        ] {
            let dashboard = Url::parse(website).unwrap();
            for status in [
                json!({}),
                json!({ "pricing_presentation": { "quota_display_type": "USD" } }),
            ] {
                let balance = present_balance(14_523_033.0, &status, &dashboard);
                assert_eq!(balance.unit.as_deref(), Some("USD"));
                assert!((balance.amount - 29.046066).abs() < 1e-10);
                assert_eq!(format!("{:.2}", balance.amount), "29.05");
            }
            assert_eq!(present_balance(0.0, &json!({}), &dashboard).amount, 0.0);
        }
    }

    #[test]
    fn heju_balance_prefers_published_scale_and_currency_settings() {
        let dashboard = Url::parse("https://www.hejuapi.com").unwrap();
        let balance = present_balance(
            14_523_033.0,
            &json!({
                "quota_per_unit": 1_000_000, "quota_display_type": "USD"
            }),
            &dashboard,
        );
        assert_eq!(balance.unit.as_deref(), Some("USD"));
        assert!((balance.amount - 14.523033).abs() < 1e-10);

        let balance = present_balance(
            1_250_000.0,
            &json!({
                "pricing_presentation": {
                    "quota_display_type": "CNY", "usd_exchange_rate": 7.2
                }
            }),
            &dashboard,
        );
        assert_eq!(balance.unit.as_deref(), Some("CNY"));
        assert_eq!(balance.amount, 18.0);

        for status in [
            json!({ "quota_per_unit": 0, "quota_display_type": "USD" }),
            json!({ "quota_display_type": "TOKENS" }),
        ] {
            let balance = present_balance(1_250_000.0, &status, &dashboard);
            assert_eq!(balance.amount, 1_250_000.0);
            assert_eq!(balance.unit, None);
        }
    }

    #[test]
    fn heju_default_conversion_does_not_apply_to_other_domains() {
        for website in [
            "https://relay.example",
            "https://hejuapi.com.example",
            "https://otherhejuapi.com",
        ] {
            let dashboard = Url::parse(website).unwrap();
            let balance = present_balance(
                14_523_033.0,
                &json!({
                    "pricing_presentation": { "quota_display_type": "USD" }
                }),
                &dashboard,
            );
            assert_eq!(balance.amount, 14_523_033.0);
            assert_eq!(balance.unit, None);
        }
    }
}
