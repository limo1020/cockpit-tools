import { invoke } from '@tauri-apps/api/core';
import { Database, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexModelProvider } from '../../services/codexModelProviderService';
import { formatModelProviderUsageMoney } from '../../services/modelProviderUsageService';

type RelayBalance = { amount: number; unit: string | null };
type Result = { request: string; balance?: RelayBalance; error?: string };

const pending = new Map<string, Promise<RelayBalance>>();

function queryBalance(providerId: string, binding: string): Promise<RelayBalance> {
  const existing = pending.get(binding);
  if (existing) return existing;
  const request = invoke<RelayBalance>('codex_query_new_api_account_balance', { providerId })
    .finally(() => pending.delete(binding));
  pending.set(binding, request);
  return request;
}

export function CodexRelayAccountBalance({ provider, refreshKey }: {
  provider: CodexModelProvider | null;
  refreshKey?: number;
}) {
  const { t, i18n } = useTranslation();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result>();
  const providerId = provider?.newApiBalance ? provider.id : undefined;
  const binding = providerId ? `${providerId}:${provider?.updatedAt}` : '';
  const request = `${binding}:${refreshKey ?? 0}:${revision}`;
  const current = result?.request === request ? result : undefined;

  useEffect(() => {
    if (!providerId) return;
    let active = true;
    void queryBalance(providerId, binding).then(balance => {
      if (active) setResult({ request, balance });
    }, error => {
      if (active) setResult({ request, error: String(error) });
    });
    return () => { active = false; };
  }, [providerId, binding, request]);

  const balance = current?.balance;
  const details = current?.error?.includes('PROVIDER_BALANCE_AUTH_FAILED')
    ? t('codex.newApi.balance.authFailed', 'Check the user ID and system access token in the provider settings.')
    : current?.error ? t('codex.newApi.balance.failed', 'Could not retrieve the balance. Try refreshing.') : undefined;
  const refreshLabel = t('codex.newApi.balance.refresh', 'Refresh relay account balance');
  let value: string;
  if (!providerId) value = t('codex.newApi.balance.notConfigured', 'Not configured');
  else if (!current) value = t('common.loading');
  else if (!balance) value = t('codex.newApi.balance.unavailable', 'Unavailable');
  else if (balance.unit) value = formatModelProviderUsageMoney(balance.amount, balance.unit);
  else value = t('codex.newApi.balance.rawQuota', '{{amount}} quota units', {
    amount: new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 }).format(balance.amount),
  });

  return <div className="quota-item codex-relay-account-balance">
    <div className="quota-header">
      <Database size={14} aria-hidden="true" />
      <span className="quota-label">{t('codex.modelProviders.usage.accountBalance', 'Account balance')}</span>
      <strong className="quota-pct" aria-live="polite">{value}</strong>
      {providerId && <button type="button" className="action-btn" disabled={!current}
        title={refreshLabel} aria-label={refreshLabel} onClick={() => setRevision(previous => previous + 1)}>
        <RefreshCw size={14} aria-hidden="true" />
      </button>}
    </div>
    {details && <span className="quota-reset">{details}</span>}
  </div>;
}
