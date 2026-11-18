import { PelicanProviderSetup } from './PelicanProviderSetup';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCodexAccountStore } from '../../../stores/useCodexAccountStore';
import { useCodexPelicanStore } from '../../../stores/useCodexPelicanStore';
import { getCodexWakeupState } from '../../../services/codexWakeupService';
import { isCodexApiKeyAccount, isCodexWebSessionAccount } from '../../../types/codex';
import type { CodexWakeupModelPreset } from '../../../types/codexWakeup';
import { CODEX_PELICAN_MAX_CONCURRENCY } from '../../../types/codexPelican';
import { SingleSelectDropdown } from '../../SingleSelectDropdown';
import { ModalErrorMessage, useModalErrorState } from '../../ModalErrorMessage';
import { pelicanError } from './pelicanUtils';
import { defaultPelicanConcurrency, parsePelicanConcurrency, pelicanAccountContext } from './pelicanSetupModel';
import { PelicanAccountSummary } from './PelicanAccountSummary';
import { PELICAN_BENCHMARKS, PELICAN_BENCHMARK_IDS, pelicanBenchmark, pelicanBenchmarkLabel, type PelicanBenchmark } from './pelicanBenchmarks';
import { PelicanReference } from './PelicanReference';

type SavedPrompt = { id: string; name: string; prompt: string };
const SAVED_PROMPTS_KEY = 'agtools.codex.pelican.savedPrompts.v1';
const PROMPT_ORDER_KEY = 'agtools.codex.pelican.promptOrder.v1';

function readPromptOrder(): string[] {
  try {
    const order: unknown = JSON.parse(localStorage.getItem(PROMPT_ORDER_KEY) ?? '[]');
    return Array.isArray(order) ? [...new Set(order.filter((value): value is string => typeof value === 'string'))] : [];
  } catch {
    return [];
  }
}

function readSavedPrompts(): SavedPrompt[] {
  try {
    const items = JSON.parse(localStorage.getItem(SAVED_PROMPTS_KEY) ?? '[]') as unknown;
    return Array.isArray(items) ? items.filter((item): item is SavedPrompt =>
      typeof item?.id === 'string' && item.id.startsWith('saved:') &&
      typeof item.name === 'string' && Boolean(item.name.trim()) &&
      typeof item.prompt === 'string' && Boolean(item.prompt.trim())) : [];
  } catch {
    return [];
  }
}

export function PelicanSetup({ mask }: { mask: (value: string) => string }) {
  const { t } = useTranslation();
  const sourceMode = useCodexPelicanStore(state => state.sourceMode);
  const providerTargets = useCodexPelicanStore(state => state.providerTargets);
  const providerMode = sourceMode === 'providers';
  const [providersValid, setProvidersValid] = useState(true);
  const accounts = useCodexAccountStore((state) => state.accounts);
  const initialIds = useCodexPelicanStore((state) => state.selectedAccountIds);
  const starting = useCodexPelicanStore((state) => state.starting);
  const [selected, setSelected] = useState(() => new Set(initialIds));
  const draft = useCodexPelicanStore(state => state.draft);
  const updateDraft = useCodexPelicanStore(state => state.updateDraft);
  const {model, prompt, effort} = draft;
  const [savedPrompts, setSavedPrompts] = useState(readSavedPrompts);
  const [promptOrder, setPromptOrder] = useState(readPromptOrder);
  const [savedPromptId, setSavedPromptId] = useState(() => savedPrompts.find(item => item.prompt === prompt)?.id);
  const [promptNameDraft, setPromptNameDraft] = useState<string | null>(null);
  const savedPrompt = savedPrompts.find(item => item.id === savedPromptId);
  const promptName = promptNameDraft ?? savedPrompt?.name ?? '';
  const setModel = (model: string) => updateDraft({model});
  const setPrompt = (prompt: string) => updateDraft({prompt});
  const setEffort = (effort: string) => updateDraft({effort});
  const [concurrency, setConcurrency] = useState(() => String(providerMode ? draft.concurrency : defaultPelicanConcurrency(initialIds.length)));
  const concurrencyManuallyEdited = useRef(false);
  const [search, setSearch] = useState('');
  const [presets, setPresets] = useState<CodexWakeupModelPreset[]>([]);
  const [localBusy, setBusy] = useState(false);
  const busy = localBusy || starting;
  const [fieldError, setFieldError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const error = useModalErrorState();
  const eligible = useMemo(() => accounts.filter((account) => !isCodexApiKeyAccount(account) && !isCodexWebSessionAccount(account)), [accounts]);
  const choices = useMemo(() => eligible.map((account) => ({
    account,
    context: pelicanAccountContext(account, account.id, account.email),
  })), [eligible]);
  const query = search.trim().toLowerCase();
  const filtered = choices.filter(({ account, context }) => [account.email, ...context, ...(account.tags ?? [])]
    .join(' ').toLowerCase().includes(query));
  const selectedIds = eligible.filter((account) => selected.has(account.id)).map((account) => account.id);

  useEffect(() => {
    if (providerMode) return;
    if (!concurrencyManuallyEdited.current) {
      setConcurrency(String(defaultPelicanConcurrency(selectedIds.length)));
    }
  }, [selectedIds.length, providerMode]);

  useEffect(() => {
    let disposed = false;
    void getCodexWakeupState().then((state) => {
      if (disposed) return;
      setPresets(state.model_presets);
      // Presets are optional choices; loading them must not override the default or user input.
    }).catch((cause) => { if (!disposed) error.set(pelicanError(cause, t)); });
    return () => { disposed = true; };
  }, [error.set, t]);

  const fieldChanged = () => { setFieldError(null); error.clear(); };
  const persistPrompts = (next: SavedPrompt[]) => {
    try {
      localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(next));
      setSavedPrompts(next);
      return true;
    } catch {
      error.set(t('pelican.savedPrompts.failed', 'Could not save questions locally.'));
      return false;
    }
  };
  const savePrompt = () => {
    if (busy || !promptName.trim() || !prompt.trim()) return;
    fieldChanged();
    const entry = { id: savedPrompt?.id ?? `saved:${crypto.randomUUID()}`, name: promptName.trim(), prompt };
    const next = savedPrompt ? savedPrompts.map(item => item.id === entry.id ? entry : item) : [...savedPrompts, entry];
    if (persistPrompts(next)) {
      setSavedPromptId(entry.id);
      setPromptNameDraft(null);
    }
  };
  const failField = (field: string) => {
    setFieldError(field);
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[data-field="${field}"]`)?.focus());
  };
  const submit = async () => {
    if (busy) return;
    error.clear(); setFieldError(null);
    if (!providerMode && !model.trim()) return failField('model');
    if (providerMode && (!providerTargets.length || !providersValid)) return failField('providers');
    const parsedConcurrency = parsePelicanConcurrency(concurrency);
    if (parsedConcurrency == null) return failField('concurrency');
    if (!prompt.trim()) return failField('prompt');
    if (!providerMode && !selectedIds.length) return failField('accounts');
    setBusy(true);
    try {
      await useCodexPelicanStore.getState().start({ accountIds: providerMode ? [] : selectedIds, ...(providerMode ? {providerTargets} : {}), prompt, model: providerMode ? providerTargets[0].model.trim() : model.trim(), effort, concurrency: parsedConcurrency });
    } catch (cause) { error.set(pelicanError(cause, t)); }
    finally { setBusy(false); }
  };

  const currentBenchmark = pelicanBenchmark(prompt);
  const benchmarkOptions = PELICAN_BENCHMARK_IDS.map((value) => ({ value, label: pelicanBenchmarkLabel(value, t) }));
  if (!PELICAN_BENCHMARK_IDS.includes(currentBenchmark)) {
    benchmarkOptions.splice(benchmarkOptions.length - 1, 0, { value: currentBenchmark, label: `${pelicanBenchmarkLabel(currentBenchmark, t)} · ${t('pelican.legacyCase')}` });
  }
  benchmarkOptions.push(...savedPrompts.map(item => ({ value: item.id, label: item.name })));
  const positions = new Map(promptOrder.map((id, index) => [id, index]));
  benchmarkOptions.sort((a, b) => (positions.get(a.value) ?? promptOrder.length) - (positions.get(b.value) ?? promptOrder.length));
  const moveQuestion = (from: string, to: string) => {
    const next = benchmarkOptions.map(option => option.value);
    const fromIndex = next.indexOf(from);
    const toIndex = next.indexOf(to);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, from);
    fieldChanged();
    try {
      localStorage.setItem(PROMPT_ORDER_KEY, JSON.stringify(next));
      setPromptOrder(next);
    } catch {
      error.set(t('pelican.savedPrompts.orderFailed', 'Could not save the question order.'));
    }
  };

  return <form className="pelican-setup" ref={formRef} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <p className="pelican-muted">{t(providerMode ? 'pelican.providerDescription' : 'pelican.description')}</p>
    <p className="pelican-muted">{t('pelican.scoringHint')}</p>
    <label>{t('pelican.benchmark')}
      <SingleSelectDropdown value={savedPrompt?.id ?? currentBenchmark} ariaLabel={t('pelican.benchmark')} disabled={busy}
        options={benchmarkOptions}
        reorder={{ onMove: moveQuestion, handleLabel: t('pelican.savedPrompts.reorder', 'Drag to reorder. With a question focused, use Alt + ↑ or Alt + ↓.') }}
        onChange={(value) => {
          const entry = savedPrompts.find(item => item.id === value);
          setSavedPromptId(entry?.id);
          setPromptNameDraft(null);
          setPrompt(entry?.prompt ?? PELICAN_BENCHMARKS[value as PelicanBenchmark]);
          fieldChanged();
        }} />
    </label>
    <label>{t('pelican.prompt')}
      <textarea data-field="prompt" value={prompt} rows={4} maxLength={100000} disabled={busy} aria-invalid={fieldError === 'prompt'} onChange={(event) => { setPrompt(event.target.value); fieldChanged(); }} />
    </label>
    {fieldError === 'prompt' && <span className="pelican-field-error" role="alert">{t('pelican.required')}</span>}
    {(savedPrompt || currentBenchmark === 'custom') && <div className="pelican-inline pelican-saved-prompt">
      <label>{t('pelican.savedPrompts.name', 'Question name')}
        <input value={promptName} maxLength={64} disabled={busy}
          onChange={event => { setPromptNameDraft(event.target.value); fieldChanged(); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); savePrompt(); } }} />
      </label>
      <button type="button" className="btn btn-secondary" onClick={savePrompt}
        disabled={busy || !promptName.trim() || !prompt.trim() || (savedPrompt?.name === promptName.trim() && savedPrompt.prompt === prompt)}>
        {t('pelican.savedPrompts.save', 'Save question')}
      </button>
      {savedPrompt && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => {
        fieldChanged();
        if (persistPrompts(savedPrompts.filter(item => item.id !== savedPrompt.id))) {
          setSavedPromptId(undefined);
          setPromptNameDraft(null);
        }
      }}>{t('pelican.savedPrompts.remove', 'Remove saved question')}</button>}
    </div>}
    <PelicanReference prompt={prompt} />
    <div className="pelican-fields">
      {!providerMode && <label>{t('pelican.model')}
        <input data-field="model" value={model} maxLength={128} disabled={busy} aria-invalid={fieldError === 'model'} onChange={(event) => { setModel(event.target.value); fieldChanged(); }} />
        {fieldError === 'model' && <span className="pelican-field-error" role="alert">{t('pelican.required')}</span>}
        {presets.length > 0 && <SingleSelectDropdown value={presets.find((preset) => preset.model === model)?.id ?? ''}
          options={presets.map((preset) => ({ value: preset.id, label: preset.name }))} placeholder={t('pelican.model')} ariaLabel={t('pelican.model')} disabled={busy}
          onChange={(id) => { const preset = presets.find((entry) => entry.id === id); if (preset) { setModel(preset.model); setEffort(preset.default_reasoning_effort); fieldChanged(); } }} />}
      </label>}
      <label>{t('pelican.effort')}<SingleSelectDropdown value={effort} ariaLabel={t('pelican.effort')} disabled={busy}
        options={['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({ value, label: t(`codex.wakeup.reasoningEfforts.${value}`) }))} onChange={(value) => { setEffort(value); fieldChanged(); }} /></label>
      <label>{t('pelican.concurrency')}
        <input data-field="concurrency" type="text" inputMode="numeric" value={concurrency} maxLength={8}
          placeholder={`1–${CODEX_PELICAN_MAX_CONCURRENCY}`} disabled={busy} aria-invalid={fieldError === 'concurrency'}
          aria-describedby={fieldError === 'concurrency' ? 'pelican-concurrency-error' : undefined}
          onChange={(event) => { concurrencyManuallyEdited.current = true; setConcurrency(event.target.value); fieldChanged(); }} />
        {fieldError === 'concurrency' && <span id="pelican-concurrency-error" className="pelican-field-error" role="alert">{t('pelican.error.invalidConcurrency')}</span>}
      </label>
    </div>
    <p className="pelican-muted">{t('pelican.deliveryHelp')}</p>
    {providerMode ? <PelicanProviderSetup busy={busy} invalid={fieldError === 'providers'} mask={mask} onValidChange={setProvidersValid} onChange={fieldChanged} /> : <>
    <div className="pelican-section-heading"><strong>{t('pelican.accounts')} ({selectedIds.length}/{eligible.length})</strong>
      <button type="button" className="btn btn-secondary" disabled={busy || !filtered.length} onClick={() => {
        const allSelected = filtered.every(({ account }) => selected.has(account.id));
        setSelected((previous) => { const next = new Set(previous); filtered.forEach(({ account }) => allSelected ? next.delete(account.id) : next.add(account.id)); return next; }); fieldChanged();
      }}>{t('common.selectAll')}</button>
    </div>
    <input type="search" value={search} placeholder={t('pelican.search')} aria-label={t('pelican.search')} onChange={(event) => setSearch(event.target.value)} />
    <div className="pelican-account-list" data-field="accounts" tabIndex={-1} aria-invalid={fieldError === 'accounts'}>
      {!eligible.length && <p>{t('pelican.emptyAccounts')}</p>}
      {filtered.map(({ account, context }) => <label className="pelican-account-choice" key={account.id}>
        <input type="checkbox" checked={selected.has(account.id)} disabled={busy} onChange={() => { setSelected((previous) => { const next = new Set(previous); if (next.has(account.id)) next.delete(account.id); else next.add(account.id); return next; }); fieldChanged(); }} />
        <span className="pelican-account-identity"><span>{mask(account.email || account.id)}</span>
          {context.length > 0 && <small className="pelican-account-context">{context.map(mask).join(' · ')}</small>}
          {account.tags?.length ? <small className="pelican-account-tags">{account.tags.join(' · ')}</small> : null}
        </span>
        <PelicanAccountSummary account={account} />
      </label>)}
    </div>
    {fieldError === 'accounts' && <span className="pelican-field-error" role="alert">{t('pelican.selectAccounts')}</span>}
    <p className="pelican-muted">{t('pelican.accountHelp')}</p></>}
    <ModalErrorMessage message={error.message} scrollKey={error.scrollKey} />
    <div className="pelican-actions"><button className="btn btn-primary" type="submit" disabled={busy}>{t(busy ? 'common.loading' : 'pelican.start')}</button></div>
  </form>;
}
