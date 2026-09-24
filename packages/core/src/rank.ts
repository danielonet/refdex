export interface WeightedEdge {
  from: number;
  to: number;
  /** Number of uses; weighted by its square root, so one caller using a type ten times doesn't dominate. */
  count: number;
}

/**
 * PageRank over the symbol graph: a symbol ranks high when many symbols use it, and more so when
 * those are highly ranked themselves. Scores sum to 1. Symbols without outgoing edges spread their
 * score evenly (the usual dangling-node handling).
 */
export function pageRank(nodes: number[], edges: WeightedEdge[], opts: { damping?: number; iterations?: number; tolerance?: number } = {}): Map<number, number> {
  const damping = opts.damping ?? 0.85;
  const n = nodes.length;
  const scores = new Map<number, number>();
  if (!n) return scores;
  const index = new Map(nodes.map((id, i) => [id, i]));
  const from: number[] = [];
  const to: number[] = [];
  const weight: number[] = [];
  const outWeight = new Float64Array(n);
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const w = Math.sqrt(e.count);
    from.push(a);
    to.push(b);
    weight.push(w);
    outWeight[a] += w;
  }

  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  for (let iter = 0; iter < (opts.iterations ?? 100); iter++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outWeight[i] === 0) dangling += rank[i];
    next.fill((1 - damping) / n + (damping * dangling) / n);
    for (let e = 0; e < from.length; e++) next[to[e]] += (damping * rank[from[e]] * weight[e]) / outWeight[from[e]];
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - rank[i]);
    [rank, next] = [next, rank];
    if (delta < (opts.tolerance ?? 1e-9)) break;
  }
  for (let i = 0; i < n; i++) scores.set(nodes[i], rank[i]);
  return scores;
}
