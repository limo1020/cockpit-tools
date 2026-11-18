export interface CodexNewApiBalanceConfig {
  origin: string;
  userId: string;
  accessToken: string;
}

export type CodexNewApiBalanceField = 'website' | 'userId' | 'accessToken';

const userIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

function parseBalanceWebsite(website?: string): URL | undefined {
  const value = website?.normalize('NFKC').trim();
  if (!value) return undefined;
  try {
    const url = new URL(/^https?:|^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function codexNewApiBalanceOrigin(website?: string): string | undefined {
  return parseBalanceWebsite(website)?.origin;
}

export function defaultCodexNewApiBalanceWebsite(baseUrl: string): string | undefined {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'hejuapi.com' || host.endsWith('.hejuapi.com') ? 'https://www.hejuapi.com' : undefined;
  } catch {
    return undefined;
  }
}

export function parseCodexNewApiBalanceInput(input: {
  website?: string;
  userId?: string;
  accessToken?: string;
}): { field: CodexNewApiBalanceField } | { config?: CodexNewApiBalanceConfig; website?: string } {
  const userIdInput = input.userId?.normalize('NFKC').trim() ?? '';
  const tokenInput = input.accessToken?.trim() ?? '';
  if (!userIdInput && !tokenInput) return {};

  const website = parseBalanceWebsite(input.website);
  if (!website) return { field: 'website' };
  const userId = userIdInput.replace(/^(?:(?:用户|账户|账号|user)\s*)?id(?:\s*:\s*|\s+)/i, '');
  if (!userIdPattern.test(userId)) return { field: 'userId' };
  const accessToken = tokenInput.replace(/^Bearer(?:\s+|$)/i, '').trim();
  if (!accessToken || /[\s\x00-\x1f\x7f]/.test(accessToken)) return { field: 'accessToken' };
  return { config: { origin: website.origin, userId, accessToken }, website: website.href };
}

export function normalizeCodexNewApiBalanceConfig(value: unknown, website?: string): CodexNewApiBalanceConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { origin, userId, accessToken } = value as Partial<CodexNewApiBalanceConfig>;
  if (!origin || origin !== codexNewApiBalanceOrigin(website) || typeof userId !== 'string' ||
      !userIdPattern.test(userId) || typeof accessToken !== 'string' || !accessToken.trim()) {
    return undefined;
  }
  return { origin, userId, accessToken: accessToken.trim() };
}
