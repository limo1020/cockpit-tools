use super::*;
use crate::commands::codex::{
    codex_account_balance_binding, codex_query_new_api_account_balance,
    new_api_balance::NewApiAccountBalance,
};

#[derive(Clone, PartialEq, Eq)]
pub(super) enum BalanceSource {
    DeepSeek {
        url: String,
        api_key: String,
    },
    Relay {
        provider_id: String,
        revision: String,
    },
}

impl BalanceSource {
    pub(super) fn for_account(account: &CodexAccount) -> Option<Self> {
        if let Some(url) = deepseek_balance_endpoint(account) {
            let api_key = account.openai_api_key.as_deref()?.trim();
            return (!api_key.is_empty()).then(|| Self::DeepSeek {
                url,
                api_key: api_key.to_owned(),
            });
        }
        if codex_quota::relay_balance_disabled() {
            return None;
        }
        let (provider_id, revision) = codex_account_balance_binding(account)?;
        Some(Self::Relay {
            provider_id,
            revision,
        })
    }

    async fn fetch(self, client: Client) -> Option<AccountBalance> {
        let result = match self {
            Self::DeepSeek { url, api_key } => {
                query_deepseek_balance_snapshot(&client, &url, &api_key)
                    .await
                    .map(AccountBalance::DeepSeek)
            }
            Self::Relay { provider_id, .. } => codex_query_new_api_account_balance(provider_id)
                .await
                .map(AccountBalance::Relay),
        };
        match result {
            Ok(value) => Some(value),
            Err(_) => {
                logger::log_warn("[Codex App Injection] 账户余额查询失败，保留上次结果");
                None
            }
        }
    }
}

#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum AccountBalance {
    DeepSeek(DeepSeekBalanceSnapshot),
    Relay(NewApiAccountBalance),
}

/// Network queries run outside the render loop. A changed provider or changed
/// dashboard configuration discards both the cached balance and any old worker.
pub(super) struct BalancePoller {
    source: Option<BalanceSource>,
    tasks: JoinSet<Option<AccountBalance>>,
    pub(super) balance: Option<AccountBalance>,
    fetched_at: Instant,
    fetch_due: bool,
    pub(super) refreshing: bool,
}

impl Default for BalancePoller {
    fn default() -> Self {
        Self {
            source: None,
            tasks: JoinSet::new(),
            balance: None,
            fetched_at: Instant::now() - ACCOUNT_BALANCE_REFRESH_INTERVAL,
            fetch_due: false,
            refreshing: false,
        }
    }
}

impl BalancePoller {
    pub(super) fn collect(&mut self, source: Option<BalanceSource>, client: &Client) {
        if self.source != source {
            self.tasks = JoinSet::new();
            self.balance = None;
            self.fetched_at = Instant::now() - ACCOUNT_BALANCE_REFRESH_INTERVAL;
            self.fetch_due = source.is_some();
            self.refreshing = false;
            self.source = source;
        }
        if let Some(result) = self.tasks.try_join_next() {
            // A click during an older automatic query requests a new snapshot.
            if !self.fetch_due {
                if let Ok(Some(value)) = result {
                    self.balance = Some(value);
                }
                self.refreshing = false;
            }
        }
        if (self.fetch_due || self.fetched_at.elapsed() >= ACCOUNT_BALANCE_REFRESH_INTERVAL)
            && self.tasks.is_empty()
        {
            if let Some(source) = self.source.clone() {
                self.fetch_due = false;
                self.fetched_at = Instant::now();
                let client = client.clone();
                self.tasks.spawn(async move {
                    timeout(Duration::from_secs(25), source.fetch(client))
                        .await
                        .ok()
                        .flatten()
                });
            }
        }
    }

    pub(super) fn refresh(&mut self) {
        self.fetch_due = self.source.is_some();
        self.refreshing = self.fetch_due;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relay_balance(amount: f64) -> AccountBalance {
        AccountBalance::Relay(NewApiAccountBalance {
            amount,
            unit: Some("USD".into()),
        })
    }

    fn seeded_poller() -> BalancePoller {
        BalancePoller {
            source: Some(BalanceSource::Relay {
                provider_id: "a".into(),
                revision: "1".into(),
            }),
            balance: Some(relay_balance(29.03)),
            fetched_at: Instant::now(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn failed_refresh_retains_balance_and_releases_loading() {
        let mut poller = seeded_poller();
        poller.refresh();
        assert!(poller.refreshing);
        poller.fetch_due = false;
        poller.tasks.spawn(async { None });
        timeout(Duration::from_secs(2), async {
            while !poller.tasks.is_empty() {
                tokio::time::sleep(Duration::from_millis(1)).await;
                poller.collect(poller.source.clone(), &Client::new());
            }
        })
        .await
        .unwrap();
        assert!(!poller.refreshing);
        assert_eq!(
            serde_json::to_value(poller.balance).unwrap()["amount"],
            29.03
        );
    }

    #[tokio::test]
    async fn unbinding_discards_a_pending_balance_from_the_previous_provider() {
        let mut poller = seeded_poller();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        poller.tasks.spawn(async move {
            receiver.await.ok()?;
            Some(relay_balance(100.0))
        });
        poller.collect(None, &Client::new());
        let _ = sender.send(());
        tokio::task::yield_now().await;
        poller.collect(None, &Client::new());
        assert!(poller.balance.is_none());
        assert!(poller.tasks.is_empty());
        assert!(!poller.refreshing);
    }

    #[tokio::test]
    async fn repeated_refresh_clicks_keep_one_query_in_flight() {
        let mut poller = seeded_poller();
        let (_sender, receiver) = tokio::sync::oneshot::channel::<()>();
        poller.tasks.spawn(async move {
            receiver.await.ok()?;
            Some(relay_balance(100.0))
        });
        for _ in 0..3 {
            poller.refresh();
            poller.collect(poller.source.clone(), &Client::new());
            assert_eq!(poller.tasks.len(), 1);
            assert!(poller.refreshing);
        }
        assert_eq!(
            serde_json::to_value(poller.balance).unwrap()["amount"],
            29.03
        );
    }
}
