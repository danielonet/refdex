import type { LanguageId } from '../languages.ts';
import { csharpAdapter } from './csharp.ts';
import { javaAdapter } from './java.ts';
import { pythonAdapter } from './python.ts';
import type { LanguageAdapter } from './types.ts';
import { typescriptAdapter } from './typescript.ts';

/** Every adapter. Adding a language means adding its grammar to LANGUAGES and an adapter here. */
export const ADAPTERS: readonly LanguageAdapter[] = [pythonAdapter, typescriptAdapter, javaAdapter, csharpAdapter];

const byLanguage = new Map<LanguageId, LanguageAdapter>(ADAPTERS.flatMap((a) => a.languages.map((l) => [l, a] as const)));

export function adapterFor(language: LanguageId): LanguageAdapter {
  const adapter = byLanguage.get(language);
  if (!adapter) throw new Error(`no adapter for ${language}`);
  return adapter;
}
