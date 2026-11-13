// The provider's fetch runs at the upstream transport, including Magpie's own
// compaction requests that bypass gateway middleware. Auth stays account-scoped.
import { sanitizeResponsesRequest, ShimError } from './lib/sanitize.mjs';

const PROVIDER = 'agentrouter-shim';
const DEFAULT_UPSTREAM = 'https://agentrouter.org/v1';
const OPERATIONS = new Set(['/responses', '/responses/compact', '/responses/input_tokens']);

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

export default async function ResponsesShimPlugin(_input, options = {}) {
  let upstream = upstreamURL(options.upstream ?? DEFAULT_UPSTREAM);

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

    auth: {
      provider: PROVIDER,
      methods: [{ type: 'api', label: 'AgentRouter API Key' }],
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
        const response = await fetch(`${base}/models`, {
          headers: { authorization: `Bearer ${auth.key}` },
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
