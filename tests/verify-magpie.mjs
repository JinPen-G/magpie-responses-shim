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
assert.ok(executable, 'Pass the installed Magpie executable path.');
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
const runFile = promisify(execFile);

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
    MAGPIE_NO_ACCOUNTS: '1',
    MAGPIE_PLUGIN_MARKET: 'off',
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
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    captures.push({ path: request.url, body });
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
  await writeFile(path.join(config, 'providers.json'), JSON.stringify({
    noAutoGroups: true,
    providers: ['agentrouter', 'other'].map(id => ({
      id, name: id, key: 'local-fixture-key',
      responses: `http://127.0.0.1:${upstreamPort}/${id}/v1`,
      models: ['fixture-model'],
      codexAsSent: true,
    })),
  }));
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({
    subscriptionAccounts: false,
    sessionReads: { asked: true, all: false, agents: {} },
  }));

  console.log((await command('--version')).trim());
  await command('plugin', 'add', repository);
  const listed = JSON.parse(await command('plugin', '--json'));
  const state = Object.values(listed.middleware ?? {})[0];
  assert.ok(state?.hooks.includes('onProvider'), 'Magpie must discover onProvider.');
  assert.ok(!state.error, state.error);
  console.log('PASS: Magpie loads the package as gateway middleware.');

  gateway = spawn(executable, ['serve'], {
    cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  gatewayClosed = new Promise(resolve => gateway.once('close', resolve));
  gateway.stdout.setEncoding('utf8').on('data', chunk => { gatewayLog += chunk; });
  gateway.stderr.setEncoding('utf8').on('data', chunk => { gatewayLog += chunk; });
  gateway.on('error', error => controller.abort(error));

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    controller.signal.throwIfAborted();
    assert.equal(gateway.exitCode, null, `Gateway exited. ${gatewayLog}`);
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(300) });
      await response.text();
      ready = true;
      break;
    } catch {
      await delay(100, undefined, { signal: controller.signal });
    }
  }
  assert.ok(ready, `Gateway did not start. ${gatewayLog}`);

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
      headers['user-agent'] = 'codex_cli_rs/0.167.0 (Windows; x86_64)';
      headers.originator = 'codex_cli_rs';
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
