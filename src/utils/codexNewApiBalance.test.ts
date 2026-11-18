import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCodexNewApiBalanceWebsite, normalizeCodexNewApiBalanceConfig, parseCodexNewApiBalanceInput } from './codexNewApiBalance';

test('public IDs survive form input, provider persistence, and the next balance query', () => {
  const website = 'https://www.hejuapi.com';
  for (const id of ['0Abc_42-X', 'iDCase123', '00127', '42']) {
    for (const input of [id, `用户 ID：${id}`]) {
      const parsed = parseCodexNewApiBalanceInput({ website, userId: input, accessToken: 'test' });
      assert.ok('config' in parsed);
      assert.equal(parsed.config?.userId, id);
      assert.deepEqual(normalizeCodexNewApiBalanceConfig(parsed.config, website), parsed.config);
    }
  }
});

test('Heju API routes share the configured dashboard website for balance queries', () => {
  for (const host of ['us.hejuapi.com', 'cdn.hejuapi.com', 'ai.hejuapi.com', 'www.hejuapi.com']) {
    assert.equal(defaultCodexNewApiBalanceWebsite(`https://${host}/v1`), 'https://www.hejuapi.com');
  }
  assert.equal(defaultCodexNewApiBalanceWebsite('https://hejuapi.com.example/v1'), undefined);
});
