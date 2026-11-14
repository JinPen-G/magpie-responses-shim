// Exercises the installed Windows Magpie with isolated settings and a loopback
// fixture provider. All files and processes created here belong to this run.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repository = fileURLToPath(new URL('..', import.meta.url));
const temporaryParent = path.join(repository, 'output', '.tmp');
const temporary = path.join(temporaryParent, 'magpie-verification');
const executable = process.argv[2] || process.env.MAGPIE_TEST_BINARY;
const bunExecutable = process.argv[3] || process.env.MAGPIE_BUN;
assert.ok(executable, 'Pass the installed Magpie executable path.');
assert.ok(bunExecutable, 'Pass an existing Bun executable path as the second argument or MAGPIE_BUN.');
assert.equal(process.platform, 'win32', 'This host verification isolates Windows USERPROFILE. Run npm test on other platforms.');

const controller = new AbortController();
const interrupt = () => controller.abort(new Error('Verification interrupted.'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

await mkdir(temporaryParent, { recursive: true });
// Exclusive creation also prevents concurrent tests from sharing this directory.
await mkdir(temporary);

let gateway;
let gatewayClosed;
let upstream;
let gatewayLog = '';
const captures = [];
const modelCaptures = [];
let rejectAccount = '';
const runFile = promisify(execFile);
const codexIdentity = {
  'User-Agent': 'codex_cli_rs/0.167.0 (Windows; x86_64)',
  Originator: 'codex_cli_rs',
  Version: '0.167.0',
};

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await closed;
}

try {
  const home = path.join(temporary, 'profile');
  const config = path.join(temporary, 'config', 'magpie');
  const folders = {
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.dirname(config),
    XDG_CACHE_HOME: path.join(temporary, 'cache'),
    XDG_DATA_HOME: path.join(temporary, 'data'),
    XDG_STATE_HOME: path.join(temporary, 'state'),
    XDG_RUNTIME_DIR: path.join(temporary, 'runtime'),
    MAGPIE_BIN_DIR: path.join(temporary, 'bin'),
    TEMP: path.join(temporary, 'temp'),
    TMP: path.join(temporary, 'temp'),
  };
  await Promise.all(Object.values(folders).map(folder => mkdir(folder, { recursive: true })));
  await mkdir(config, { recursive: true });

  const reservation = http.createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  const env = {
    SystemRoot: process.env.SystemRoot,
    SystemDrive: process.env.SystemDrive,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATH: path.join(process.env.SystemRoot, 'System32'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ...folders,
    MAGPIE_ADDR: `127.0.0.1:${port}`,
    // Account-backed provider plugins require discovery. Every profile and
    // credential location here is an empty directory owned by this test.
    MAGPIE_NO_ACCOUNTS: '0',
    MAGPIE_PLUGIN_MARKET: 'off',
    MAGPIE_BUN: bunExecutable,
    DO_NOT_TRACK: '1',
  };

  const command = async (...args) => {
    const result = await runFile(executable, args, {
      env, cwd: temporary, windowsHide: true, timeout: 45000,
      maxBuffer: 2 * 1024 * 1024, signal: controller.signal,
    });
    return result.stdout;
  };

  upstream = http.createServer(async (request, response) => {
    if (request.method === 'GET') {
      if (request.url === '/shim/v1/models') {
        modelCaptures.push(request.headers);
        if (request.headers['user-agent'] !== codexIdentity['User-Agent']
          || request.headers.originator !== codexIdentity.Originator) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Fixture requires recorded Codex client identity.' } }));
          return;
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    captures.push({
      path: request.url,
      body,
      headers: {
        'user-agent': request.headers['user-agent'],
        originator: request.headers.originator,
        version: request.headers.version,
        'session-id': request.headers['session-id'],
        session_id: request.headers.session_id,
        'thread-id': request.headers['thread-id'],
        'x-codex-turn-metadata': request.headers['x-codex-turn-metadata'],
        'x-responses-shim-session': request.headers['x-responses-shim-session'],
        authorization: request.headers.authorization,
      },
    });
    if (['/agentrouter/v1/responses', '/shim/v1/responses'].includes(request.url) && body.input.some(item =>
      item.type === 'reasoning' || ['msg_old', 'fc_old', 'fco_old', 'at_old'].includes(item.id))) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'The requested item was created under a different Azure OpenAI resource.' } }));
      return;
    }
    if (request.url === '/shim/v1/responses' && (request.headers['user-agent'] !== codexIdentity['User-Agent']
      || request.headers.originator !== codexIdentity.Originator)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture requires recorded Codex client identity.' } }));
      return;
    }
    if (request.url === '/shim/v1/responses' && request.headers.authorization === rejectAccount) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Fixture account is rate limited.' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const completed = {
      id: 'resp_fixture', object: 'response', status: 'completed', model: 'fixture-model',
      output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n');
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`);
  });
  const upstreamPort = await listen(upstream);
  await writeFile(path.join(config, 'plugins.json'), JSON.stringify({
    plugins: [{ spec: repository, options: { upstream: `http://127.0.0.1:${upstreamPort}/shim/v1`, log: true } }],
  }));
  await writeFile(path.join(config, 'plugin-auth.json'), JSON.stringify({
    'agentrouter-shim': { type: 'api', key: 'local-fixture-key' },
    'agentrouter-shim#second': { type: 'api', key: 'second-fixture-key' },
  }));
  await writeFile(path.join(config, 'providers.json'), JSON.stringify({
    noAutoGroups: true,
    providers: [
      ...['agentrouter', 'other'].map(id => ({
        id, name: id, key: 'local-fixture-key',
        responses: `http://127.0.0.1:${upstreamPort}/${id}/v1`,
        models: ['fixture-model'],
        codexAsSent: true,
      })),
    ],
  }));
  // A fixture of Magpie's recorded real-client profile, without configuring
  // PassHeaders on the plugin provider. No production client identity is used.
  await writeFile(path.join(config, 'client-shapes.json'), JSON.stringify({
    codex: Object.fromEntries(Object.entries(codexIdentity).map(([name, value]) => [name, [value]])),
  }));
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({
    sessionReads: { asked: true, all: false, agents: {} },
  }));

  console.log((await command('--version')).trim());
  const listed = JSON.parse(await command('plugin', '--json'));
  const state = Object.values(listed.middleware ?? {})[0];
  assert.ok(state?.hooks.includes('onProvider'), 'Magpie must discover onProvider.');
  assert.ok(!state.error, state.error);
  const listedProvider = listed.providers.find(provider => provider.id === 'agentrouter-shim');
  assert.ok(listedProvider?.models.some(model => model.id === 'fixture-model'));
  assert.equal(listedProvider.accounts.length, 2);
  assert.notEqual(listedProvider.single, true);
  assert.deepEqual(listedProvider.options.map(option => [option.key, option.default === true]), [
    ['codex-headers', false], ['models-codex-headers', true],
  ]);
  assert.ok(modelCaptures.length > 0);
  assert.ok(modelCaptures.every(headers => headers['user-agent'] === codexIdentity['User-Agent']
    && headers.originator === codexIdentity.Originator));
  assert.deepEqual(new Set(modelCaptures.map(headers => headers.authorization)),
    new Set(['Bearer local-fixture-key', 'Bearer second-fixture-key']));
  await command('plugin', 'options', repository, JSON.stringify({ 'codex-headers': true }));
  await command('provider', 'set', 'agentrouter-shim', 'routing=rotate');
  console.log('PASS: Magpie loads the provider switches, discovers models with Codex identity, and saves the conversation switch through its CLI.');

  const base = `http://127.0.0.1:${port}`;
  const startGateway = async () => {
    gateway = spawn(executable, ['serve'], {
      cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    gatewayClosed = new Promise(resolve => gateway.once('close', resolve));
    gateway.stdout.setEncoding('utf8').on('data', chunk => { gatewayLog += chunk; });
    gateway.stderr.setEncoding('utf8').on('data', chunk => { gatewayLog += chunk; });
    gateway.on('error', error => controller.abort(error));
    for (let attempt = 0; attempt < 80; attempt++) {
      controller.signal.throwIfAborted();
      assert.equal(gateway.exitCode, null, `Gateway exited. ${gatewayLog}`);
      try {
        await (await fetch(base, { signal: AbortSignal.timeout(300) })).text();
        return;
      } catch {
        await delay(100, undefined, { signal: controller.signal });
      }
    }
    assert.fail(`Gateway did not start. ${gatewayLog}`);
  };
  await startGateway();

  const cases = [
    { provider: 'agentrouter', asSent: false },
    { provider: 'agentrouter', asSent: true },
    { provider: 'other', asSent: true },
  ];
  for (const { provider, asSent } of cases) {
    const body = {
      model: `${provider}/fixture-model`, stream: true, store: false,
      input: [
        { type: 'reasoning', id: 'rs_old', summary: [], encrypted_content: 'fixture-ciphertext' },
        { type: 'additional_tools', id: 'at_old', role: 'developer', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { id: { type: 'string' } } } }] },
        { type: 'message', id: 'msg_old', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Earlier answer', annotations: [] }] },
        { type: 'function_call', id: 'fc_old', call_id: 'call_pair', name: 'lookup', arguments: '{"id":"business-id"}' },
        { type: 'function_call_output', id: 'fco_old', call_id: 'call_pair', output: '{"id":"business-id","result":"ok"}' },
        { role: 'user', content: 'Continue' },
      ],
      tools: [{ type: 'function', name: 'baseline', parameters: { type: 'object', properties: {} } }],
    };
    const captureStart = captures.length;
    const headers = { 'content-type': 'application/json' };
    if (asSent) {
      // Fixture headers select Magpie's real Codex forwarding branch locally.
      headers['user-agent'] = codexIdentity['User-Agent'];
      headers.originator = codexIdentity.Originator;
    }
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    const returned = await response.text();
    assert.equal(response.status, 200, returned);
    assert.match(returned, /response.completed/);
    const sent = captures.slice(captureStart).find(capture => capture.path === `/${provider}/v1/responses`)?.body;
    assert.ok(sent, `No request reached the ${provider} fixture.`);
    if (asSent) {
      const additionalTools = sent.input.find(item => item.type === 'additional_tools');
      assert.deepEqual(additionalTools?.tools, body.input[1].tools);
      assert.deepEqual(sent.tools, body.tools);
    } else {
      // Magpie's fromLite moves complete additional_tools definitions into tools.
      assert.ok(!sent.input.some(item => item.type === 'additional_tools'));
      assert.deepEqual(sent.tools, [...body.tools, ...body.input[1].tools]);
    }
    if (provider === 'agentrouter') {
      assert.ok(!sent.input.some(item => item.type === 'reasoning'));
      assert.ok(!sent.input.some(item => ['at_old', 'msg_old', 'fc_old', 'fco_old'].includes(item.id)));
      const call = sent.input.find(item => item.type === 'function_call');
      const result = sent.input.find(item => item.type === 'function_call_output');
      assert.equal(call.call_id, result.call_id);
      assert.equal(call.arguments, '{"id":"business-id"}');
      assert.equal(result.output, '{"id":"business-id","result":"ok"}');
    } else {
      assert.ok(sent.input.some(item => item.type === 'reasoning'));
    }
    console.log(`PASS: ${provider} ${asSent ? 'Codex as-sent' : 'standard'} request and SSE verified through Magpie.`);
  }

  const compactHistory = {
    model: 'agentrouter/fixture-model', stream: true, store: false,
    input: [
      { type: 'reasoning', id: 'rs_old', summary: [], encrypted_content: 'fixture-ciphertext' },
      { type: 'message', id: 'msg_old', role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer', annotations: [] }] },
      { role: 'user', content: 'Continue the work' },
      { type: 'compaction_trigger' },
    ],
  };
  const headers = {
    'content-type': 'application/json',
    'user-agent': codexIdentity['User-Agent'],
    originator: codexIdentity.Originator,
    'session-id': 'fixture-session',
    'x-codex-turn-metadata': '{"thread_id":"fixture-thread","turn_id":"fixture-turn"}',
  };
  const post = async (body, expectedStatus = 200) => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    });
    const text = await response.text();
    assert.equal(response.status, expectedStatus, text);
    if (expectedStatus !== 200) return text;
    assert.match(text, /response.completed/);
    return text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  };

  let captureStart = captures.length;
  await post({ model: 'agentrouter-shim/fixture-model', stream: true, input: [{ role: 'user', content: 'Hello' }] });
  const normalSent = captures.slice(captureStart).find(capture => capture.path === '/shim/v1/responses');
  assert.equal(normalSent?.headers['user-agent'], codexIdentity['User-Agent']);
  assert.equal(normalSent?.headers.originator, codexIdentity.Originator);
  assert.equal(normalSent?.headers['session-id'], 'fixture-session');
  console.log('PASS: provider conversation headers reach the fixture without a PassHeaders configuration.');

  captureStart = captures.length;
  const compactError = await post(compactHistory, 400);
  assert.match(compactError, /different Azure OpenAI resource/);
  const uncleanedCompact = captures.slice(captureStart).find(capture => capture.path === '/agentrouter/v1/responses')?.body;
  assert.ok(uncleanedCompact?.input.some(item => item.type === 'reasoning'), 'The fixture must reproduce the middleware bypass during compaction.');
  console.log('PASS: reproduced compaction bypassing gateway middleware.');

  captureStart = captures.length;
  const compactEvents = await post({ ...compactHistory, model: 'agentrouter-shim/fixture-model' });
  const compactSent = captures.slice(captureStart).filter(capture => capture.path === '/shim/v1/responses');
  assert.equal(compactSent.length, 1, `The provider transport must clean the first summary attempt.\n${gatewayLog.slice(-12000)}\n${JSON.stringify(captures.slice(captureStart))}`);
  assert.ok(!compactSent[0].body.input.some(item => item.type === 'reasoning' || item.id === 'msg_old'));
  assert.ok(compactSent[0].body.input.some(item => JSON.stringify(item).includes('Earlier answer')));
  assert.equal(compactSent[0].headers['user-agent'], headers['user-agent']);
  assert.equal(compactSent[0].headers.originator, headers.originator);
  assert.equal(compactSent[0].headers.version, codexIdentity.Version);
  assert.equal(compactSent[0].headers['session-id'], 'fixture-session');
  assert.equal(compactSent[0].headers.session_id, 'fixture-session');
  assert.equal(compactSent[0].headers['thread-id'], 'fixture-session');
  assert.equal(compactSent[0].headers['x-codex-turn-metadata'], undefined);
  assert.equal(compactSent[0].headers['x-responses-shim-session'], undefined);
  assert.ok(['Bearer local-fixture-key', 'Bearer second-fixture-key'].includes(compactSent[0].headers.authorization));
  const compactItem = compactEvents.find(event => event.type === 'response.output_item.done' && event.item?.type === 'compaction')?.item;
  assert.ok(compactItem?.encrypted_content?.startsWith('magpie1:'), 'Magpie must return its portable text summary.');
  assert.equal(Buffer.from(compactItem.encrypted_content.slice('magpie1:'.length), 'base64').toString(), 'OK');
  captureStart = captures.length;
  await post({ model: 'agentrouter-shim/fixture-model', stream: true, store: false, input: [compactItem, { role: 'user', content: 'Continue after compaction' }] });
  const continued = captures.slice(captureStart).find(capture => capture.path === '/shim/v1/responses');
  assert.ok(continued?.body.input.some(item => JSON.stringify(item).includes('OK')));
  assert.ok(!continued.body.input.some(item => item.type === 'compaction'));
  assert.equal(continued.headers['session-id'], compactSent[0].headers['session-id']);
  assert.equal(continued.headers['user-agent'], codexIdentity['User-Agent']);
  console.log('PASS: provider transport cleans compaction, supplies recorded Codex identity and current session, and continues the conversation after its summary.');

  captureStart = captures.length;
  for (let index = 0; index < 4; index++) {
    headers['session-id'] = `rotation-${index}`;
    await post({ model: 'agentrouter-shim/fixture-model', stream: true, input: [{ role: 'user', content: `Round ${index}` }] });
  }
  const rotated = captures.slice(captureStart).filter(capture => capture.path === '/shim/v1/responses');
  assert.deepEqual(new Set(rotated.map(capture => capture.headers.authorization)),
    new Set(['Bearer local-fixture-key', 'Bearer second-fixture-key']));
  console.log('PASS: Magpie rotates requests across two separate API-key accounts.');

  gateway.kill();
  await gatewayClosed;
  await command('provider', 'set', 'agentrouter-shim', 'routing=order');
  await startGateway();
  rejectAccount = 'Bearer local-fixture-key';
  headers['session-id'] = 'failover-session';
  captureStart = captures.length;
  await post({ ...compactHistory, model: 'agentrouter-shim/fixture-model' });
  const failover = captures.slice(captureStart).filter(capture => capture.path === '/shim/v1/responses');
  assert.deepEqual(failover.map(capture => capture.headers.authorization),
    ['Bearer local-fixture-key', 'Bearer second-fixture-key']);
  for (const capture of failover) {
    assert.ok(!capture.body.input.some(item => item.type === 'reasoning' || item.id === 'msg_old'));
    assert.equal(capture.headers['session-id'], 'failover-session');
    assert.equal(capture.headers['user-agent'], codexIdentity['User-Agent']);
  }
  console.log('PASS: Magpie retries a rate-limited compaction with the second key, cleaning every account attempt.');
  assert.ok(!/middleware .*\[(?:error|warn)\]/.test(gatewayLog), gatewayLog);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (gateway?.pid && gateway.exitCode === null) {
    gateway.kill();
  }
  await gatewayClosed;
  await closeServer(upstream);
  const resolvedRepository = await realpath(repository);
  const resolvedParent = await realpath(temporaryParent);
  const resolvedTemporary = await realpath(temporary);
  assert.equal(resolvedParent, path.join(resolvedRepository, 'output', '.tmp'), 'Cleanup parent left the repository.');
  assert.equal(path.dirname(resolvedTemporary), resolvedParent, 'Cleanup target left the test directory.');
  await rm(resolvedTemporary, { recursive: true, force: true });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  console.log('CLEANUP: temporary files and test processes removed.');
}
