// What a run costs, priced the same way for every run so earlier runs' cache hits don't count.

/**
 * Input token usage of one API call. (Output tokens come from the session total: Claude Code's
 * per-message usage in stream-json is captured before the message finishes.)
 */
export interface Call {
  input: number;
  cacheWrite: number;
  cacheRead: number;
}

/** List prices per model, $ per million input and output tokens (2026-09). */
const LIST: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

/**
 * $ per token for a model. Claude Code caches with a 1-hour TTL, whose writes cost 2x the input
 * price; cache reads cost 0.1x.
 */
export function pricesFor(model: string) {
  const list = LIST[model];
  if (!list) throw new Error(`no prices for ${model}; add them to bench/cost.ts`);
  return { input: list.input / 1e6, cacheWrite1h: (2 * list.input) / 1e6, cacheRead: (0.1 * list.input) / 1e6, output: list.output / 1e6 };
}

/**
 * Cost of a run with caching inside the run (each turn re-sends the conversation, as for any user)
 * but none carried over from earlier runs: the first call writes its whole context to the cache;
 * each later call reads what the previous call had and writes only what is new. The total context
 * per call is the same whether the cache was warm or cold, so the cost depends only on the run itself.
 */
export function costOf(calls: Call[], outputTokens: number, model: string): number {
  const prices = pricesFor(model);
  let cost = outputTokens * prices.output;
  let previous = 0;
  for (const c of calls) {
    const context = c.input + c.cacheWrite + c.cacheRead;
    const read = Math.min(previous, context);
    cost += read * prices.cacheRead + (context - read) * prices.cacheWrite1h;
    previous = context;
  }
  return cost;
}
