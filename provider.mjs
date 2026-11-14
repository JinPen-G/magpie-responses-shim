// The provider's fetch runs at the upstream transport, including Magpie's own
// compaction requests that bypass gateway middleware. Auth stays account-scoped.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeResponsesRequest, ShimError } from './lib/sanitize.mjs';

const PROVIDER = 'agentrouter-shim';
const DEFAULT_UPSTREAM = 'https://agentrouter.org/v1';
const OPERATIONS = new Set(['/responses', '/responses/compact', '/responses/input_tokens']);
const IDENTITY_HEADERS = new Set(['user-agent', 'originator', 'version']);
const SESSION_HINT = 'x-responses-shim-session';

function upstreamURL(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new TypeError('upstream must be HTTPS, or loopback HTTP, without URL credentials, a query or a fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function errorResponse(status, code, message, param = null) {
  const type = status === 401 ? 'authentication_error' : 'invalid_request_error';
  return Response.json({ error: { type, code, message, param } }, { status });
}

export default async function ResponsesShimPlugin(input = {}, options = {}) {
  let upstream = upstreamURL(options.upstream ?? DEFAULT_UPSTREAM);

  function enabled(key, fallback) {
    if (typeof input.magpie?.option === 'function') return input.magpie.option(PROVIDER, key) === true;
    return (options[key] ?? fallback) === true;
  }

  async function codexHeaders(received) {
    let profile = options.codexHeaders;
    // Prefer the actual request when Magpie already passed its Codex identity.
    // The saved profile contains identity only, never another turn's session.
    if (profile === undefined && received?.get('user-agent')?.toLowerCase().includes('codex')) {
      profile = Object.fromEntries(received);
    }
    if (profile === undefined) {
      try {
        const saved = JSON.parse(await readFile(path.join(input.directory, 'client-shapes.json'), 'utf8'));
        profile = saved.codex;
      } catch {
        throw new ShimError(400, 'codex_headers_unavailable',
          'Codex client headers are unavailable. Run a real Codex request through a Magpie API-key provider, or set codexHeaders to its actual identity headers.');
      }
    }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new ShimError(400, 'codex_headers_unavailable', 'No recorded Codex client identity is available.');
    }
    const headers = new Headers();
    for (const [name, values] of Object.entries(profile)) {
      if (!IDENTITY_HEADERS.has(name.toLowerCase())) continue;
      const value = Array.isArray(values) ? values[0] : values;
      if (typeof value !== 'string' || !value.trim()) continue;
      try {
        headers.set(name, value);
      } catch {
        throw new ShimError(400, 'invalid_codex_headers', 'Codex identity header values must be valid HTTP header strings.');
      }
    }
    if (!headers.has('user-agent') && !headers.has('originator')) {
      throw new ShimError(400, 'codex_headers_unavailable', 'Codex identity requires its actual User-Agent or Originator.');
    }
    const version = headers.get('user-agent')?.match(/^[^/]+\/(\d[\w.+-]*)/)?.[1];
    if (!headers.has('version') && version) headers.set('version', version);
    return headers;
  }

  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {};
      const provider = cfg.provider[PROVIDER];
      provider.name ??= 'AgentRouter 修复';
      provider.npm ??= '@ai-sdk/openai';
      provider.api ??= upstream.href.replace(/\/$/, '');
      provider.models ??= {};
      // An explicit OpenCode config entry is the same upstream for discovery
      // and transport, so account credentials are used only on that service.
      upstream = upstreamURL(provider.api);
    },

    'chat.headers': async (request, output) => {
      if (request.model?.providerID !== PROVIDER || !enabled('codex-headers', false)) return;
      if (typeof request.sessionID === 'string' && request.sessionID.trim()) {
        // Supply Magpie's conversation ID per call. The transport removes this
        // private hint and preserves any session headers it actually received.
        output.headers[SESSION_HINT] = request.sessionID.trim();
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [{ type: 'api', label: 'AgentRouter API Key' }],
      options: [
        {
          key: 'codex-headers', label: '对话请求带 Codex 头', default: false,
          description: '开启后使用实际 Codex 的 User-Agent、Originator、Version，并补齐当前会话头。覆盖普通对话与压缩摘要。默认关闭。',
        },
        {
          key: 'models-codex-headers', label: '查询模型时带 Codex 头', default: true,
          description: '查询上游模型列表时使用实际 Codex 客户端头。默认开启。关闭后使用宿主客户端头，上游可能返回 401。',
        },
      ],
      async loader(getAuth) {
        const base = upstream.href.replace(/\/$/, '');
        return {
          baseURL: base,
          async fetch(input, init) {
            const request = new Request(input, init);
            const target = new URL(request.url);
            const basePath = upstream.pathname.replace(/\/$/, '');
            if (target.origin !== upstream.origin || !target.pathname.startsWith(basePath + '/')) {
              return errorResponse(400, 'upstream_mismatch', 'The request URL is outside the configured upstream.');
            }
            request.signal.throwIfAborted();
            const auth = await getAuth();
            if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim()) {
              return errorResponse(401, 'missing_api_key', 'Sign in to the AgentRouter 修复 provider with its API key.');
            }

            const headers = new Headers(request.headers);
            headers.set('authorization', `Bearer ${auth.key}`);
            const operation = target.pathname.slice(basePath.length).replace(/\/$/, '');
            const session = headers.get('session-id') || headers.get('session_id')
              || headers.get('x-magpie-session') || headers.get(SESSION_HINT);
            headers.delete(SESSION_HINT);
            headers.delete('x-magpie-session');
            const conversation = request.method === 'POST'
              && (OPERATIONS.has(operation) || operation === '/chat/completions');
            const useCodexHeaders = conversation && enabled('codex-headers', false);
            const modelQuery = request.method === 'GET' && operation === '/models'
              && enabled('models-codex-headers', true);
            if (useCodexHeaders || modelQuery) {
              try {
                for (const [name, value] of await codexHeaders(headers)) headers.set(name, value);
              } catch (error) {
                if (error instanceof ShimError) return errorResponse(error.status, error.code, error.message);
                throw error;
              }
            }
            if (useCodexHeaders && session) {
              for (const name of ['session-id', 'session_id', 'thread-id']) {
                if (!headers.has(name)) headers.set(name, session);
              }
            }
            if (request.method !== 'POST' || !OPERATIONS.has(operation)) {
              return fetch(new Request(request, { headers, redirect: 'error' }));
            }

            const encoding = headers.get('content-encoding');
            if (encoding && encoding.toLowerCase() !== 'identity') {
              return errorResponse(415, 'encoded_body_unsupported', 'The provider expects decoded JSON from Magpie.');
            }
            const original = await request.text();
            let parsed;
            try {
              parsed = JSON.parse(original);
            } catch {
              return errorResponse(400, 'invalid_json', 'The Responses request body must be valid JSON.');
            }
            let cleaned;
            try {
              cleaned = sanitizeResponsesRequest(parsed);
            } catch (error) {
              if (error instanceof ShimError) {
                return errorResponse(error.status, error.code, error.message, error.param);
              }
              throw error;
            }
            const { body, stats } = cleaned;
            const changed = stats.reasoning_items_removed > 0 || stats.item_ids_removed > 0;
            if (options.log === true && (changed || stats.opaque_state_items > 0)) {
              console.info('responses-shim-provider', JSON.stringify(stats));
            }
            if (changed) {
              for (const key of ['content-length', 'content-encoding', 'content-md5', 'digest']) headers.delete(key);
              headers.set('content-type', 'application/json');
            }
            return fetch(new Request(request, {
              headers, body: changed ? JSON.stringify(body) : original, redirect: 'error',
            }));
          },
        };
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth, signal } = {}) {
        if (auth?.type !== 'api' || !auth.key) return provider.models;
        const base = upstream.href.replace(/\/$/, '');
        const headers = enabled('models-codex-headers', true) ? await codexHeaders() : new Headers();
        headers.set('authorization', `Bearer ${auth.key}`);
        const response = await fetch(`${base}/models`, {
          headers,
          signal, redirect: 'error',
        });
        if (!response.ok) throw new Error(`The upstream model list returned HTTP ${response.status}.`);
        const payload = await response.json();
        if (!Array.isArray(payload.data)) throw new TypeError('The upstream model list must contain a data array.');
        const models = Object.create(null);
        for (const model of payload.data) {
          if (!model || typeof model.id !== 'string' || !model.id.trim()) continue;
          const prior = Object.hasOwn(provider.models ?? {}, model.id) ? provider.models[model.id] : {};
          models[model.id] = {
            ...prior,
            id: model.id,
            name: prior.name ?? model.id,
            api: { ...prior.api, id: prior.api?.id ?? model.id, npm: '@ai-sdk/openai', url: base },
          };
        }
        return models;
      },
    },
  };
}
