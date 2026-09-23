export type LanguageId = 'python' | 'typescript' | 'tsx' | 'java' | 'csharp';

/** Every .wasm file the parser needs: the tree-sitter runtime plus one grammar per language. */
export const WASM_MODULE_PATHS = {
  'web-tree-sitter.wasm': 'web-tree-sitter/web-tree-sitter.wasm',
  'tree-sitter-python.wasm': 'tree-sitter-python/tree-sitter-python.wasm',
  'tree-sitter-typescript.wasm': 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm': 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  'tree-sitter-java.wasm': 'tree-sitter-java/tree-sitter-java.wasm',
  'tree-sitter-c_sharp.wasm': 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm',
} as const;

export type WasmFile = keyof typeof WASM_MODULE_PATHS;

export const LANGUAGES: Record<LanguageId, { wasm: WasmFile; extensions: string[] }> = {
  python: { wasm: 'tree-sitter-python.wasm', extensions: ['.py', '.pyi'] },
  typescript: { wasm: 'tree-sitter-typescript.wasm', extensions: ['.ts', '.mts', '.cts'] },
  tsx: { wasm: 'tree-sitter-tsx.wasm', extensions: ['.tsx'] },
  java: { wasm: 'tree-sitter-java.wasm', extensions: ['.java'] },
  csharp: { wasm: 'tree-sitter-c_sharp.wasm', extensions: ['.cs'] },
};

export function languageForPath(path: string): LanguageId | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = path.slice(dot).toLowerCase();
  return (Object.keys(LANGUAGES) as LanguageId[]).find((id) => LANGUAGES[id].extensions.includes(ext));
}
