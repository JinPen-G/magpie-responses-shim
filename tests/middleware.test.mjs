import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { onProvider } from '../responses.middleware.mjs';
import { sanitizeResponsesRequest } from '../lib/sanitize.mjs';

const context = (provider = 'agentrouter', options = {}) => ({
  protocol: 'responses',
  path: '/v1/responses',
  model: 'group/coding',
  provider: { id: provider, model: 'fixture-model' },
  options,
  state: {},
});

const history = () => ({
  model: 'group/coding',
  stream: true,
  store: false,
  include: ['reasoning.encrypted_content'],
  reasoning: { effort: 'high' },
  prompt_cache_key: 'fixture-cache',
  input: [
    { type: 'reasoning', id: 'rs_old', encrypted_content: 'fixture-ciphertext' },
    {
      type: 'additional_tools', id: 'at_old', role: 'developer',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { id: { type: 'string' } } } }],
    },
    { type: 'message', id: 'msg_old', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Looking up the item.' }] },
    { type: 'function_call', id: 'fc_old', call_id: 'call_pair', name: 'lookup', arguments: '{"id":"business-id"}' },
    { type: 'function_call_output', id: 'fco_old', call_id: 'call_pair', output: '{"id":"business-id","result":"ok"}' },
    { type: 'custom_tool_call', id: 'ct_old', call_id: 'custom_pair', name: 'custom', input: 'id=business-id' },
    { type: 'custom_tool_call_output', id: 'cto_old', call_id: 'custom_pair', output: 'ok' },
    { role: 'user', content: [{ type: 'input_text', text: 'Continue' }, { type: 'input_image', image_url: 'data:image/png;base64,fixture' }] },
  ],
});

test('cleans replayable history and retains content, call pairs, tools and request settings', () => {
  const original = history();
  const before = structuredClone(original);
  const cleaned = onProvider(original, context());
  const expected = structuredClone(original);
  expected.input.shift();
  for (const item of expected.input) delete item.id;
  assert.deepEqual(cleaned, expected);
  assert.deepEqual(original, before);
  assert.equal(cleaned.input[2].call_id, cleaned.input[3].call_id);
  assert.equal(cleaned.input[4].call_id, cleaned.input[5].call_id);
  assert.equal(cleaned.input[1].phase, 'commentary');
});

test('uses the actual provider for each attempt, including a routing group', () => {
  const original = history();
  const before = structuredClone(original);
  assert.equal(onProvider(original, context('openai')), undefined);
  assert.equal(onProvider(original, { ...context(), protocol: 'anthropic' }), undefined);
  assert.ok(onProvider(original, context('agentrouter')));
  assert.equal(onProvider(original, context('another-provider')), undefined);
  assert.deepEqual(original, before);
});

test('implements defaults and explicit provider lists', () => {
  const original = history();
  const missingOptions = context();
  delete missingOptions.options;
  assert.ok(onProvider(original, missingOptions));
  assert.equal(onProvider(original, context('agentrouter', { providers: [] })), undefined);
  assert.ok(onProvider(original, context('relay', { providers: ['relay'] })));
  assert.equal(onProvider(original, context('agentrouter', { providers: ['relay'] })), undefined);
  assert.throws(() => onProvider(original, context('agentrouter', { providers: 'agentrouter' })), /array of provider IDs/);
});

test('preserves opaque references, encrypted compaction, incomplete and hosted items', () => {
  const opaque = {
    previous_response_id: 'resp_old',
    conversation: 'conv_old',
    context_management: [{ type: 'compaction', compact_threshold: 1000 }],
    input: [
      { type: 'item_reference', id: 'ref_old' },
      { id: 'bare_ref' },
      { type: 'compaction', id: 'cmp_old', encrypted_content: 'sole-history' },
      { type: 'additional_tools', id: 'tools_incomplete' },
      { type: 'function_call_output', id: 'output_incomplete', output: 'missing pair' },
      { type: 'web_search_call', id: 'search_old', action: { type: 'search', query: 'fixture' } },
      { type: 'future_item', id: 'future_old', encrypted_content: 'opaque' },
      { role: 'user', content: [{ type: 'input_file', file_id: 'file_old' }] },
    ],
  };
  const before = structuredClone(opaque);
  assert.equal(onProvider(opaque, context()), undefined);
  assert.deepEqual(sanitizeResponsesRequest(opaque).body, before);
  assert.deepEqual(opaque, before);
  assert.throws(() => sanitizeResponsesRequest(opaque, { strict: true }), /original upstream resource/);
});

test('returns undefined when no resource-bound content needs rewriting', () => {
  for (const body of [
    { input: 'Hello' },
    { input: [{ role: 'user', content: 'Hello' }] },
    { input: [{ type: 'function_call_output', call_id: 'pair', output: 'ok' }] },
  ]) {
    assert.equal(onProvider(body, context()), undefined);
  }
});

test('optional diagnostics contain counters only', () => {
  const captured = [];
  const originalInfo = console.info;
  console.info = (...args) => captured.push(args);
  try {
    onProvider(history(), context());
    assert.equal(captured.length, 0);
    onProvider(history(), context('agentrouter', { log: true }));
    assert.equal(captured.length, 1);
    assert.equal(captured[0][0], 'responses-shim');
    assert.deepEqual(JSON.parse(captured[0][1]), {
      reasoning_items_removed: 1,
      item_ids_removed: 6,
      opaque_state_items: 0,
    });
  } finally {
    console.info = originalInfo;
  }
});

test('package is directly loadable as middleware and declares real default options', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.magpie.middleware, './responses.middleware.mjs');
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.exports, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.ok(pkg.files.includes('lib/sanitize.mjs'));
  assert.deepEqual(onProvider(history(), context('agentrouter', pkg.magpie.options)), onProvider(history(), context()));
});
