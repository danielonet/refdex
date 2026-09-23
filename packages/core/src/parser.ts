import { Language, Parser, Query, type Tree } from 'web-tree-sitter';
import { LANGUAGES, type LanguageId } from './languages.ts';
import { DEFINITION_QUERIES } from './queries.ts';
import { nodeModulesWasmLoader, type WasmLoader } from './wasm.ts';

export interface LoadedLanguage {
  id: LanguageId;
  language: Language;
  definitions: Query;
}

/** Owns the tree-sitter runtime and lazily loads one grammar per language. */
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
        return { id, language, definitions: new Query(language, DEFINITION_QUERIES[id]) };
      })();
      this.languages.set(id, loaded);
    }
    return loaded;
  }

  async parse(id: LanguageId, source: string): Promise<{ tree: Tree; lang: LoadedLanguage }> {
    const lang = await this.language(id);
    this.parser.setLanguage(lang.language);
    const tree = this.parser.parse(source);
    if (!tree) throw new Error(`tree-sitter returned no tree for ${id}`);
    return { tree, lang };
  }
}
