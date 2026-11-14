import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ResponsesShimPlugin from '../provider.mjs';

const codexIdentity = {
  'User-Agent': 'codex_fixture/1.2.3 (test)',
  Originator: 'codex_fixture',
  Version: '1.2.3',
};

async function fixture(t, options = {}, input = {}) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ path: request.url, headers: request.headers, raw: Buffer.concat(chunks).toString() });
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 'second-model' }] }));
    } else if (request.url === '/v1/redirect') {
      response.writeHead(302, { location: '/other-origin' });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const hooks = await ResponsesShimPlugin(input, { upstream: base, codexHeaders: codexIdentity, ...options });
  const config = {};
  await hooks.config(config);
  return { calls, base, hooks, config };
}

const history = () => ({
  model: 'fixture-model',
  input: [
    { type: 'reasoning', id: 'rs_old', encrypted_content: 'fixture-reasoning' },
    { type: 'additional_tools', id: 'at_old', tools: [{ type: 'function', name: 'lookup' }] },
    { type: 'message', id: 'msg_old', role: 'assistant', phase: 'commentary', content: 'Checking' },
    { type: 'function_call', id: 'fc_old', call_id: 'pair', name: 'lookup', arguments: '{"id":"business-id"}' },
    { type: 'function_call_output', id: 'fco_old', call_id: 'pair', output: 'done' },
    { role: 'user', content: 'Continue' },
  ],
  store: false,
  stream: true,
  prompt_cache_key: 'fixture-cache',
});

test('provider transport cleans normal, compact and input-token requests and preserves SSE', async t => {
  const { hooks, base, calls } = await fixture(t);
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fixture-key' }));
  for (const operation of ['responses', 'responses/compact', 'responses/input_tokens']) {
    const original = history();
    const response = await loader.fetch(`${base}/${operation}`, {
      method: 'POST', body: JSON.stringify(original),
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong', digest: 'old', 'x-test': 'kept' },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    const sent = calls.at(-1);
    const expected = structuredClone(original);
    expected.input.shift();
    for (const item of expected.input) delete item.id;
    assert.deepEqual(JSON.parse(sent.raw), expected);
    assert.equal(sent.headers.authorization, 'Bearer fixture-key');
    assert.equal(sent.headers['x-test'], 'kept');
    assert.equal(sent.headers.digest, undefined);
    assert.equal(sent.path, `/v1/${operation}`);
  }
});

test('transport preserves opaque compaction history and ordinary JSON bytes', async t => {
  const { hooks, base, calls } = await fixture(t);
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fixture-key' }));
  const raw = '{ "model": "fixture-model", "input": [{"type":"compaction","encrypted_content":"sole-history"}], "previous_response_id":"old" }';
  await (await loader.fetch(`${base}/responses`, { method: 'POST', body: raw })).text();
  assert.equal(calls.at(-1).raw, raw);
});

test('requests use current account auth and cancellation stops an upstream call', async t => {
  const { hooks, base, calls } = await fixture(t);
  let auth = { type: 'api', key: 'first-key' };
  const loader = await hooks.auth.loader(async () => auth);
  auth = { type: 'api', key: 'second-key' };
  await (await loader.fetch(`${base}/responses`, { method: 'POST', body: JSON.stringify(history()) })).text();
  assert.equal(calls[0].headers.authorization, 'Bearer second-key');
  auth = null;
  const unsigned = await loader.fetch(`${base}/responses`, { method: 'POST', body: '{}' });
  assert.equal(unsigned.status, 401);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loader.fetch(`${base}/responses`, { method: 'POST', body: '{}', signal: controller.signal }));
  assert.equal(calls.length, 1);
});

test('multiple account loaders keep their keys isolated during concurrent requests', async t => {
  const { hooks, base, calls } = await fixture(t, { 'codex-headers': true });
  assert.notEqual(hooks.auth.single, true);
  const [first, second] = await Promise.all([
    hooks.auth.loader(async () => ({ type: 'api', key: 'first-fixture-key' })),
    hooks.auth.loader(async () => ({ type: 'api', key: 'second-fixture-key' })),
  ]);
  await Promise.all([first, second].map(async (loader, index) => {
    const response = await loader.fetch(`${base}/responses`, {
      method: 'POST', body: JSON.stringify(history()), headers: { 'session-id': `session-${index}` },
    });
    await response.text();
  }));
  assert.deepEqual(new Set(calls.map(call => call.headers.authorization)),
    new Set(['Bearer first-fixture-key', 'Bearer second-fixture-key']));
  for (const call of calls) {
    assert.ok(!JSON.parse(call.raw).input.some(item => item.type === 'reasoning' || item.id));
    assert.equal(call.headers['user-agent'], codexIdentity['User-Agent']);
  }
});

test('invalid JSON, compressed bodies and other destinations never reach the upstream', async t => {
  const { hooks, base, calls } = await fixture(t);
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fixture-key' }));
  for (const body of ['bad json', 'null', '[]']) {
    assert.equal((await loader.fetch(`${base}/responses`, { method: 'POST', body })).status, 400);
  }
  assert.equal((await loader.fetch(`${base}/responses`, {
    method: 'POST', body: '{}', headers: { 'content-encoding': 'gzip' },
  })).status, 415);
  assert.equal((await loader.fetch('https://other.example/v1/responses', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await loader.fetch(new URL('/outside', base), { method: 'POST', body: '{}' })).status, 400);
  assert.equal(calls.length, 0);
});

test('provider discovers actual model IDs and preserves explicit model metadata', async t => {
  const { hooks, config, base, calls } = await fixture(t);
  const prior = {
    'fixture-model': { name: 'Fixture', limit: { context: 12345, output: 100 }, capabilities: { input: { image: true } } },
  };
  const models = await hooks.provider.models({ models: prior }, { auth: { type: 'api', key: 'fixture-key' } });
  assert.deepEqual(Object.keys(models), ['fixture-model', 'second-model']);
  assert.deepEqual(models['fixture-model'].limit, prior['fixture-model'].limit);
  assert.equal(models['second-model'].limit, undefined);
  assert.equal(models['second-model'].cost, undefined);
  assert.equal(models['fixture-model'].api.url, base);
  assert.equal(models['fixture-model'].api.npm, '@ai-sdk/openai');
  assert.equal(config.provider['agentrouter-shim'].api, base);
  assert.equal(calls[0].headers.authorization, 'Bearer fixture-key');
  assert.equal(calls[0].headers['user-agent'], codexIdentity['User-Agent']);
  assert.equal(calls[0].headers.originator, codexIdentity.Originator);
  assert.equal(calls[0].headers.version, codexIdentity.Version);
  assert.equal(calls[0].headers['session-id'], undefined);
  assert.equal(await hooks.provider.models({ models: prior }), prior);
});

test('explicit upstream configuration is shared by model discovery and transport', async t => {
  const { base, calls } = await fixture(t);
  const hooks = await ResponsesShimPlugin({}, { upstream: 'https://unused.example/v1' });
  const config = { provider: { 'agentrouter-shim': { api: base, name: 'Existing' } } };
  await hooks.config(config);
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fixture-key' }));
  assert.equal(config.provider['agentrouter-shim'].name, 'Existing');
  assert.equal(loader.baseURL, base);
  await (await loader.fetch(`${base}/responses`, { method: 'POST', body: '{}' })).text();
  assert.equal(calls.length, 1);
});

test('transport refuses redirects and upstream URLs carrying credentials', async t => {
  const { hooks, base, calls } = await fixture(t);
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fixture-key' }));
  await assert.rejects(loader.fetch(`${base}/redirect`));
  assert.equal(calls.length, 1);
  for (const upstream of ['http://remote.example/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret']) {
    await assert.rejects(ResponsesShimPlugin({}, { upstream }));
  }
});

test('declared provider switches have the screenshot defaults and apply without recreating the loader', async t => {
  const values = { 'codex-headers': false, 'models-codex-headers': true };
  const input = { magpie: { option(provider, key) {
    assert.equal(provider, 'agentrouter-shim');
    return values[key];
  } } };
  const { hooks, base, calls } = await fixture(t, {}, input);
  assert.deepEqual(hooks.auth.options.map(option => [option.key, option.default]), Object.entries(values));
  assert.ok(hooks.auth.options.every(option => option.label && option.description));
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fixture-key' }));
  const raw = '{ "model": "fixture-model", "input": "Hello" }';
  const received = { 'User-Agent': 'magpie-fixture', Originator: 'original-client', 'x-test': 'kept' };

  await (await loader.fetch(`${base}/responses`, { method: 'POST', headers: received, body: raw })).text();
  assert.equal(calls.at(-1).headers['user-agent'], 'magpie-fixture');
  assert.equal(calls.at(-1).headers.originator, 'original-client');
  assert.equal(calls.at(-1).raw, raw);

  values['codex-headers'] = true;
  for (const operation of ['responses', 'responses/compact', 'responses/input_tokens', 'chat/completions']) {
    const output = { headers: {} };
    await hooks['chat.headers']({ model: { providerID: 'agentrouter-shim' }, sessionID: operation }, output);
    await (await loader.fetch(`${base}/${operation}`, {
      method: 'POST', headers: { ...received, ...output.headers }, body: raw,
    })).text();
    const sent = calls.at(-1);
    assert.equal(sent.headers['user-agent'], codexIdentity['User-Agent']);
    assert.equal(sent.headers.originator, codexIdentity.Originator);
    assert.equal(sent.headers.version, codexIdentity.Version);
    assert.equal(sent.headers['x-test'], 'kept');
    assert.equal(sent.headers.authorization, 'Bearer fixture-key');
    assert.equal(sent.headers['session-id'], operation);
    assert.equal(sent.headers.session_id, operation);
    assert.equal(sent.headers['thread-id'], operation);
    assert.equal(sent.headers['x-responses-shim-session'], undefined);
    assert.equal(sent.raw, raw);
  }

  values['codex-headers'] = false;
  const output = { headers: {} };
  await hooks['chat.headers']({ model: { providerID: 'agentrouter-shim' }, sessionID: 'unused' }, output);
  assert.deepEqual(output.headers, {});
  await (await loader.fetch(`${base}/responses`, { method: 'POST', headers: received, body: raw })).text();
  assert.equal(calls.at(-1).headers['user-agent'], 'magpie-fixture');
});

test('session hints are request-scoped, preserve actual metadata and never affect another provider', async t => {
  const { hooks, base, calls } = await fixture(t, { 'codex-headers': true });
  const output = { headers: {} };
  await hooks['chat.headers']({ model: { providerID: 'other' }, sessionID: 'other-session' }, output);
  assert.deepEqual(output.headers, {});
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fixture-key' }));
  const send = async sessionID => {
    const out = { headers: {} };
    await hooks['chat.headers']({ model: { providerID: 'agentrouter-shim' }, sessionID }, out);
    await (await loader.fetch(`${base}/responses`, { method: 'POST', headers: out.headers, body: '{}' })).text();
    return calls.at(-1).headers;
  };
  const [first, second] = await Promise.all([send('first-session'), send('second-session')]);
  assert.deepEqual(new Set(calls.map(call => call.headers['session-id'])), new Set(['first-session', 'second-session']));
  assert.equal(first['x-responses-shim-session'], undefined);
  assert.equal(second['x-responses-shim-session'], undefined);

  await (await loader.fetch(`${base}/responses`, {
    method: 'POST', body: '{}', headers: {
      'session-id': 'original-session', 'thread-id': 'original-thread',
      'x-magpie-session': 'host-session', 'x-responses-shim-session': 'derived-session',
      'x-codex-turn-metadata': '{"turn_id":"actual-turn"}',
    },
  })).text();
  const sent = calls.at(-1).headers;
  assert.equal(sent['session-id'], 'original-session');
  assert.equal(sent.session_id, 'original-session');
  assert.equal(sent['thread-id'], 'original-thread');
  assert.equal(sent['x-codex-turn-metadata'], '{"turn_id":"actual-turn"}');
  assert.equal(sent['x-magpie-session'], undefined);
  assert.equal(sent['x-responses-shim-session'], undefined);
});

test('model query switch applies independently in discovery and transport', async t => {
  const values = { 'codex-headers': true, 'models-codex-headers': false };
  const { hooks, base, calls } = await fixture(t, {}, { magpie: { option: (_provider, key) => values[key] } });
  const auth = { type: 'api', key: 'fixture-key' };
  const loader = await hooks.auth.loader(async () => auth);
  await hooks.provider.models({ models: {} }, { auth });
  assert.notEqual(calls.at(-1).headers['user-agent'], codexIdentity['User-Agent']);
  assert.equal(calls.at(-1).headers.originator, undefined);
  await (await loader.fetch(`${base}/models`, { headers: { 'User-Agent': 'host-fixture' } })).text();
  assert.equal(calls.at(-1).headers['user-agent'], 'host-fixture');
  values['models-codex-headers'] = true;
  await hooks.provider.models({ models: {} }, { auth });
  assert.equal(calls.at(-1).headers['user-agent'], codexIdentity['User-Agent']);
  await (await loader.fetch(`${base}/models`)).text();
  assert.equal(calls.at(-1).headers.originator, codexIdentity.Originator);
});

test('saved client profile refreshes identity only and explicit identity overrides it', async t => {
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const temporary = path.join(repository, 'output', '.tmp', 'magpie-verification');
  await mkdir(path.dirname(temporary), { recursive: true });
  await mkdir(temporary);
  t.after(async () => {
    assert.equal(await realpath(temporary), path.join(await realpath(repository), 'output', '.tmp', 'magpie-verification'));
    await rm(temporary, { recursive: true });
  });
  const profilePath = path.join(temporary, 'client-shapes.json');
  await writeFile(profilePath, JSON.stringify({ codex: {
    'User-Agent': [codexIdentity['User-Agent']], Originator: [codexIdentity.Originator],
    Authorization: ['other-key'], 'Session-Id': ['old-session'], 'X-Codex-Turn-Metadata': ['old-turn'],
  } }));
  const { hooks, base, calls } = await fixture(t, { codexHeaders: undefined, 'codex-headers': true }, { directory: temporary });
  const auth = { type: 'api', key: 'fixture-key' };
  await hooks.provider.models({ models: {} }, { auth });
  assert.equal(calls.at(-1).headers.version, '1.2.3');
  assert.equal(calls.at(-1).headers.authorization, 'Bearer fixture-key');
  assert.equal(calls.at(-1).headers['session-id'], undefined);
  assert.equal(calls.at(-1).headers['x-codex-turn-metadata'], undefined);
  const loader = await hooks.auth.loader(async () => auth);
  await writeFile(profilePath, JSON.stringify({ codex: { 'User-Agent': ['codex_fixture/2.0.0'], Originator: ['codex_fixture'] } }));
  await (await loader.fetch(`${base}/responses`, { method: 'POST', body: '{}' })).text();
  assert.equal(calls.at(-1).headers['user-agent'], 'codex_fixture/2.0.0');
  assert.equal(calls.at(-1).headers.version, '2.0.0');
  await (await loader.fetch(`${base}/responses`, {
    method: 'POST', body: '{}', headers: codexIdentity,
  })).text();
  assert.equal(calls.at(-1).headers['user-agent'], codexIdentity['User-Agent']);

  const explicit = await ResponsesShimPlugin({ directory: temporary }, { upstream: base, codexHeaders: codexIdentity });
  await explicit.provider.models({ models: {} }, { auth });
  assert.equal(calls.at(-1).headers['user-agent'], codexIdentity['User-Agent']);
  assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).codex['User-Agent'][0], 'codex_fixture/2.0.0');
});

test('missing identity gives an actionable error while received Codex identity remains usable', async t => {
  const { hooks, base, calls } = await fixture(t, { codexHeaders: undefined, 'codex-headers': true });
  const auth = { type: 'api', key: 'fixture-key' };
  const loader = await hooks.auth.loader(async () => auth);
  await assert.rejects(hooks.provider.models({ models: {} }, { auth }), error => error.code === 'codex_headers_unavailable');
  const response = await loader.fetch(`${base}/responses`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'codex_headers_unavailable');
  assert.equal(calls.length, 0);

  await (await loader.fetch(`${base}/responses`, {
    method: 'POST', headers: codexIdentity, body: '{}',
  })).text();
  assert.equal(calls.at(-1).headers['user-agent'], codexIdentity['User-Agent']);
  const invalid = await ResponsesShimPlugin({}, { upstream: base, codexHeaders: { 'User-Agent': 'invalid\r\nheader' } });
  await assert.rejects(invalid.provider.models({ models: {} }, { auth }), error => error.code === 'invalid_codex_headers');
  assert.equal(calls.length, 1);
});
