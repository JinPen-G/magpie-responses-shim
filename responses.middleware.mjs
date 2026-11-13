// Runs before a selected provider attempt. The sanitizer edits protocol-level
// history while preserving explicit content and unresolved resource references.
import { sanitizeResponsesRequest } from './lib/sanitize.mjs';

export function onProvider(body, ctx) {
  if (ctx.protocol !== 'responses') return;

  const providers = ctx.options?.providers ?? ['agentrouter'];
  if (!Array.isArray(providers) || !providers.every(id => typeof id === 'string')) {
    throw new TypeError('The providers option must be an array of provider IDs.');
  }
  if (!providers.includes(ctx.provider?.id)) return;

  const { body: cleaned, stats } = sanitizeResponsesRequest(body);
  const changed = stats.reasoning_items_removed > 0 || stats.item_ids_removed > 0;

  if (ctx.options?.log === true && (changed || stats.opaque_state_items > 0)) {
    // Counts only. Prompt text, keys, tool content and ID values stay out of logs.
    console.info('responses-shim', JSON.stringify(stats));
  }

  if (changed) return cleaned;
}
