import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface PathAlias {
  /** Text before the `*` (the whole pattern if there is none). */
  prefix: string;
  /** Text after the `*`; undefined for exact patterns. */
  suffix?: string;
  /** Absolute target patterns, with `*` kept. */
  targets: string[];
}

export interface TsConfig {
  dir: string;
  baseUrl?: string;
  /** Longest prefix first, as TypeScript matches them. */
  paths: PathAlias[];
}

/** Loads a tsconfig.json with its `extends` chain. Returns undefined if it cannot be read. */
export function loadTsConfig(file: string, workspaceRoot: string, seen = new Set<string>()): TsConfig | undefined {
  if (seen.has(file)) return undefined;
  seen.add(file);
  let json: { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    json = parseJsonc(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const dir = dirname(file);
  const bases = (Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [])
    .map((spec) => resolveExtends(spec, dir, workspaceRoot))
    .filter((f): f is string => !!f)
    .map((f) => loadTsConfig(f, workspaceRoot, seen))
    .filter((c): c is TsConfig => !!c);

  const base = bases.at(-1);
  const opts = json.compilerOptions ?? {};
  const baseUrl = opts.baseUrl !== undefined ? resolve(dir, opts.baseUrl) : base?.baseUrl;
  let paths = base?.paths ?? [];
  if (opts.paths) {
    // Relative to baseUrl if set, else to the tsconfig that declares them.
    const from = baseUrl ?? dir;
    paths = Object.entries(opts.paths).map(([pattern, targets]) => {
      const star = pattern.indexOf('*');
      return {
        prefix: star < 0 ? pattern : pattern.slice(0, star),
        suffix: star < 0 ? undefined : pattern.slice(star + 1),
        targets: targets.map((t) => resolve(from, t)),
      };
    });
    paths.sort((a, b) => b.prefix.length - a.prefix.length);
  }
  return { dir, baseUrl, paths };
}

/** Candidate paths for a non-relative specifier from `paths` and `baseUrl`, in priority order. */
export function aliasCandidates(config: TsConfig, spec: string): string[] {
  const out: string[] = [];
  for (const alias of config.paths) {
    if (alias.suffix === undefined) {
      if (spec === alias.prefix) out.push(...alias.targets);
    } else if (spec.startsWith(alias.prefix) && spec.endsWith(alias.suffix) && spec.length >= alias.prefix.length + alias.suffix.length) {
      const star = spec.slice(alias.prefix.length, spec.length - alias.suffix.length);
      out.push(...alias.targets.map((t) => t.replace('*', star)));
    }
  }
  if (config.baseUrl) out.push(join(config.baseUrl, spec));
  return out;
}

function resolveExtends(spec: string, dir: string, workspaceRoot: string): string | undefined {
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const file = resolve(dir, spec);
    return file.endsWith('.json') ? file : `${file}.json`;
  }
  // A package, e.g. "@tsconfig/node22/tsconfig.json": look it up in node_modules.
  for (const base of [dir, workspaceRoot]) {
    try {
      const require = createRequire(join(base, 'noop.js'));
      return require.resolve(spec.endsWith('.json') ? spec : `${spec}/tsconfig.json`);
    } catch {
      // try the next base
    }
  }
  return undefined;
}

/** JSON with comments and trailing commas, as tsconfig.json allows. */
export function parseJsonc(text: string): any {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
