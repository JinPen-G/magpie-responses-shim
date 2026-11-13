import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import ResponsesShimPlugin from '../provider.mjs';

async function fixture(t) {
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
  const hooks = await ResponsesShimPlugin({}, { upstream: base });
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
