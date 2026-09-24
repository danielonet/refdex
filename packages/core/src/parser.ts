import { Language, Parser, Query, type Tree } from 'web-tree-sitter';
import { adapterFor } from './adapters/index.ts';
import type { LanguageAdapter } from './adapters/types.ts';
import { LANGUAGES, type LanguageId } from './languages.ts';
import type { ParsedFile } from './model.ts';
import { nodeModulesWasmLoader, type WasmLoader } from './wasm.ts';
import type { Workspace } from './workspace.ts';

export interface LoadedLanguage {
  id: LanguageId;
  language: Language;
  adapter: LanguageAdapter;
  definitions: Query;
}

/** Owns the tree-sitter runtime and lazily loads one grammar (and its adapter's query) per language. */
export class TreeSitter {
  private readonly parser = new Parser();
  private readonly languages = new Map<LanguageId, Promise<LoadedLanguage>>();
  private readonly loadWasm: WasmLoader;

  private constructor(loadWasm: WasmLoader) {
    this.loadWasm = loadWasm;
  }

  static async create(loadWasm: WasmLoader = nodeModulesWasmLoader): Promise<TreeSitter> {
    await Parser.init({ wasmBinary: await loadWasm('web-tree-sitter.wasm') });
    return new TreeSitter(loadWasm);
  }

  language(id: LanguageId): Promise<LoadedLanguage> {
    let loaded = this.languages.get(id);
    if (!loaded) {
      loaded = (async () => {
        const language = await Language.load(await this.loadWasm(LANGUAGES[id].wasm));
        const adapter = adapterFor(id);
        return { id, language, adapter, definitions: new Query(language, adapter.definitions) };
      })();
      this.languages.set(id, loaded);
    }
    return loaded;
  }

  async parseTree(id: LanguageId, source: string): Promise<{ tree: Tree; lang: LoadedLanguage }> {
    const lang = await this.language(id);
    this.parser.setLanguage(lang.language);
    const tree = this.parser.parse(source);
    if (!tree) throw new Error(`tree-sitter returned no tree for ${id}`);
    return { tree, lang };
  }

  /** Parses one file with its language adapter. `workspace` supplies module names for Python/TypeScript. */
  async parseFile(path: string, id: LanguageId, source: string, workspace?: Workspace): Promise<ParsedFile> {
    const { tree, lang } = await this.parseTree(id, source);
    try {
      const module = workspace ? lang.adapter.moduleName?.(path, workspace) : undefined;
      return lang.adapter.parse({ path, tree, query: lang.definitions, language: id, module });
    } finally {
      tree.delete();
    }
  }
}
