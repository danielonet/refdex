# RefDex Docs Index: Structured Search over Markdown and Text Files

2026-11-04

## Overview and goals

Repositories carry documentation (`README.md`, `CLAUDE.md`, `docs/*.md`, ADRs, changelogs, runbooks) that AI clients read to get context. Today the agent finds it with grep and whole-file reads. Both are blunt: grep returns lines with no structure, and a whole-file read costs the full file for the one section that mattered.

Markdown is not free text. It has a tree (headings, sub-headings), blocks (paragraphs, lists, numbered steps, tables, code fences) and links. This plan indexes that structure into the same SQLite database RefDex already uses for code, so the agent can ask for "the section about X across all docs" and receive only that section, ranked, under a token budget.

- **Section is the unit, not the line.** A hit is a heading with its breadcrumb (`Host plan > Memory management > Rules`), not a line number in the middle of a table.
- **One query across all docs.** Ranked results over every `.md` and `.txt` file in the project, one call.
- **Fewer tokens.** Return outline first, then only the sections needed; tables come back as rows with their header.
- **Docs linked to code.** A doc that mentions `IndexQueue` is connected to the `IndexQueue` symbol, so code questions can pull the relevant doc section and doc questions can pull the code.
- **Measured against grep.** Same bench harness as the code tools (`bench/`), same metrics: tokens, tool calls, answer accuracy.

Non-goals: semantic search with a hosted embedding service, editing docs, rst/adoc/MDX in the first version, answering questions (the AI client does that).

## Why grep falls short on docs

| Situation | What grep does | What a structured index does |
| --- | --- | --- |
| Query is a concept ("how do we handle idle projects") | Matches only the literal words; misses "going cold", "tiers" | Ranks sections by BM25 over title, path and body, with heading words weighted higher |
| A hit is in a table row | Returns one row, no column names | Returns the row with the table header, or the whole small table |
| A hit is a list item | Returns one bullet, no parent | Returns the item plus its list context and section breadcrumb |
| Same fact in five files | Five hits, equal weight | Groups by document, ranks by document type (README, ADR) and link popularity |
| The AI needs the section | Greps, then reads the file (or `-A 40` and guesses the end) | `get_section` returns exactly the heading's line range |
| The AI is unsure what exists | Greps for headings with a regex | `get_doc_outline` returns the heading tree of one or all files |
| Result is too big | No limit | Hard token budget with detail levels |
| Doc mentions a symbol that was renamed | Nothing | Mention table shows dangling references (doc drift) |

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where to store | Same `index.db` per project, new tables, schema version 9 | One watcher, one queue, one database to ship; the index is a cache so a version bump just rebuilds |
| Markdown parser | `mdast-util-from-markdown` with the GFM and front-matter extensions (pure JS) | Gives node positions (line and offset) for tables, lists and headings; no native or wasm build. `markdown-it` token maps are the alternative; see open questions |
| Text files | Heuristic structure detection, then fixed-window fallback | `.txt` has no grammar; see the text section |
| Search | SQLite FTS5 with BM25 and per-column weights | Already used for `symbols_fts`; no new dependency |
| Embeddings | Not in the first version; optional later phase, local model only | Keeps the index offline and small; measure whether lexical search is enough first |
| Unit of retrieval | Section (heading to next heading of same or higher level), split into chunks when large | Matches how people write and how the AI asks |
| Summaries | Extractive (first paragraph, table header), made at index time | No LLM at index time; deterministic and cacheable |
| Tool count | Three new tools, plus docs folded into `get_context` | Every tool definition costs tokens in every conversation; keep the surface small |

## Data model

Files go into the existing `files` table with `language = 'markdown'` or `'text'` (the `project`, `hash`, `chars` and `indexed_at` columns already fit). New tables:

```sql
-- One row per heading (and one synthetic root per file for text before the first heading).
CREATE TABLE doc_sections (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES doc_sections(id) ON DELETE CASCADE,
  level INTEGER NOT NULL,          -- 0 root, 1..6 heading depth
  ord INTEGER NOT NULL,            -- position among siblings
  title TEXT NOT NULL,
  path TEXT NOT NULL,              -- breadcrumb: 'Host plan > Memory management > Rules'
  anchor TEXT NOT NULL,            -- GitHub-style slug, for #links
  start_line INTEGER NOT NULL,     -- heading line
  end_line INTEGER NOT NULL,       -- last line before the next heading of same or higher level
  own_end_line INTEGER NOT NULL,   -- last line before the next heading of any level
  chars INTEGER NOT NULL,          -- characters of the whole section, for the token budget
  own_chars INTEGER NOT NULL,
  summary TEXT                     -- first paragraph, truncated at a sentence boundary
);

-- Searchable pieces of a section's own content (not its children).
CREATE TABLE doc_blocks (
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- paragraph / list / table / code / quote
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,              -- plain text for search (markup stripped)
  chars INTEGER NOT NULL
);

-- Table rows, so a row can be returned with its header.
CREATE TABLE doc_table_rows (
  block_id INTEGER NOT NULL REFERENCES doc_blocks(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  line INTEGER NOT NULL,
  cells TEXT NOT NULL              -- JSON array; header stored on the block as row_index 0
);

-- Links between docs, and from docs to files and anchors.
CREATE TABLE doc_links (
  from_section_id INTEGER NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE,
  target TEXT NOT NULL,            -- as written
  to_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  to_section_id INTEGER REFERENCES doc_sections(id) ON DELETE SET NULL,
  line INTEGER NOT NULL
);

-- Code identifiers a doc mentions: `IndexQueue`, `serve.ts`, `refdex mcp`.
CREATE TABLE doc_mentions (
  section_id INTEGER NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,              -- as written in backticks or a code span
  to_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  to_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  line INTEGER NOT NULL
);

CREATE VIRTUAL TABLE doc_fts USING fts5(
  title, path, body,
  content='', tokenize='porter unicode61 remove_diacritics 2'
);
```

Notes:

- **Front matter** (`---` YAML at the top) is stored as the root section's text, and `title`, `tags`, `status` are copied into the root section's `path` and `summary`.
- **Foreign-key indexes.** Same rule as `db.ts`: every foreign key gets an index, or deleting a file scans whole tables.
- **FTS content.** `doc_fts` holds one row per section with `title`, `path` and the section's own text. Rows for a file are deleted and re-inserted when its hash changes, as for symbols.
- **Identifier splitting.** `IndexQueue`, `index_queue` and `index-queue` must match each other and the words "index queue". At index time add a split form (`index queue`) to the `body` column next to the original. Do the same to the query. This is the main thing plain grep cannot do.
- **Code fences** are stored as `code` blocks (searchable, low weight). They are not parsed for symbols; the code index already covers real source.
- **Size caps.** Skip files over a size limit (default 512 KB) and generated or vendored docs (`node_modules`, `CHANGELOG` beyond the last N sections, files matching `.gitignore`). Show skipped files in the status report.

## Parsing Markdown

1. Parse with mdast. Walk the top-level nodes in order, keeping a stack of open headings.
2. A `heading` node closes every open section of the same or deeper level, then opens a new one. `end_line` is filled when the section closes.
3. For each block under the current heading, write a `doc_blocks` row with plain text (strip emphasis, link syntax and HTML, keep inline code text).
4. A `table` node becomes one block plus `doc_table_rows`. The block's `text` is the header followed by rows as `col: value` pairs, so a query for a column name or a cell value both hit.
5. A `list` node becomes one block. Ordered lists keep their numbers in `text` (steps stay steps). Nested items stay inside their parent block; they are not separate blocks, so the breadcrumb is the list's section.
6. `inlineCode` and `link` nodes feed `doc_mentions` and `doc_links`. A mention is resolved against `symbols` (exact `name` or `qualified_name`) and `files` (path suffix). Unresolved mentions are kept, as unresolved `edges` are, so a later index can link them.
7. Setext headings (`Title\n=====`), headings inside blockquotes and HTML `<h2>` are handled by the parser or ignored; do not hand-roll them.
8. Large sections: if a section's own text exceeds a limit (about 1,500 tokens), chunk it at block boundaries so FTS ranks the right part. Chunks share the section's breadcrumb.

## Parsing plain text

`.txt` has no syntax, so detect structure in order of confidence and stop at the first that fits:

1. **Markdown-like** (lines starting with `#`, or `===`/`---` underlines): treat as Markdown.
2. **Numbered headings** (`1.`, `1.2`, `Section 3`, `Chapter 2`) and **ALL CAPS** lines followed by a blank line: headings; nesting from the number depth.
3. **Underlined titles** (a line followed by a line of only `=`, `-` or `~`).
4. **None of the above:** paragraphs split on blank lines, grouped into windows of about 300 tokens with one paragraph of overlap. The "section" is the window; its title is its first line; the breadcrumb is the file name.

Also handle: `LICENSE`, `NOTICE` and similar boilerplate (down-weighted by file name), and log-like files (excluded by default; `.log` is not on the list).

## Retrieval

### Ranking

For a query, tokenize with the identifier splitter, then:

1. FTS5 BM25 over `doc_fts` with column weights, for example `bm25(doc_fts, 8.0, 4.0, 1.0)` (title, path, body). A word in a heading is a strong signal.
2. Multiply by a **document-type weight**: `CLAUDE.md`, `AGENTS.md` and `README.md` highest, ADRs and `docs/` next, changelogs and generated files lowest.
3. Add a **link score**: sections and files that other docs link to rank slightly higher (the same PageRank code `rank.ts` uses for symbols, run over `doc_links`).
4. Add a **code proximity score** when the query contains a symbol the index knows: sections that mention that symbol, or a symbol in the same file, get a boost. This reuses the seeds step of `get_context`.
5. Optionally a **recency** nudge from `git log` for the file (stale docs lose ties). Off until measured.

Return the top sections grouped by file, at most one or two sections per file unless the query is narrow, so the answer is not five hits from one document.

### Detail levels and the token budget

Same idea as `get_context` in the v2 plan, with levels for sections:

| Level | Content | Typical cost |
| --- | --- | --- |
| 0 | Excluded | 0 |
| 1 | Breadcrumb, file, line range | 10 to 25 tokens |
| 2 | Level 1 + summary (first paragraph) + table headers | 50 to 120 tokens |
| 3 | Level 2 + best-matching blocks (for example the matching table rows or list items) | 150 to 400 tokens |
| 4 | Whole section text | `own_chars` / 4 |

Pack greedily by value per extra token, stopping at the budget minus headroom. A small section is cheaper to show whole than to describe; the packer sees that from `own_chars`.

## MCP tools

Three new tools. Names and arguments:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_docs` | `query`, `budget?` (tokens, default 2000), `path?` (folder or file glob), `kind?` (`table`, `list`, `code`) | Ranked sections with breadcrumbs, file and line range, packed at the levels above. Says how many more matches exist and what would be needed to see them |
| `get_doc_outline` | `path?` (file or folder), `depth?` | Heading tree with line ranges and `chars` per section, so the AI can see where to read before reading. With no path: one line per doc file with its title and top-level headings |
| `get_section` | `path` + `heading` (or a `section_id`/`anchor` from a search result), `include_children?`, `table_rows?` (filter) | The section text exactly, optionally with child sections, or only the rows of a table whose cells match |

Also:

- **`get_context`** gains a `docs` portion: after choosing seed symbols it adds the doc sections that mention them (level 2 by default), within the same budget. A coding task then sees "the plan says memory rule 4 is idle projects going cold" next to `ProjectManager`, without a separate call.
- **`find_references`** reports doc sections that mention the symbol under a separate heading, "Mentioned in docs". Cheap and often what the AI needs when changing behavior that a plan describes.
- **Instructions and tool descriptions** (`instructions` in `mcp.ts`) get two lines: use `search_docs` before grepping docs; use `get_doc_outline` then `get_section` instead of reading a whole `.md`. Test that this actually changes the agent's behavior (see evaluation).

## Extras the structure makes possible

- **Doc drift report.** Mentions with `to_symbol_id IS NULL` where the name looks like an identifier and no file matches: "the plan mentions `ProjectManager.sleep` and it no longer exists". Shown in the status report and as a section in `search_docs` when a hit contains one.
- **Broken links.** `doc_links` with no target file or anchor.
- **Task lists.** `- [ ]` and `- [x]` items indexed as a block kind, so "what is still open in the host plan" is one query.
- **Decision tables.** Tables whose first header is "Decision", "Question", "Option" are tagged and weighted up for "why did we" questions.

## Incremental indexing

- Same scan and watcher as code. `.md`, `.markdown`, `.txt` go through a docs adapter beside `adapters/`, selected by extension in `languageForPath`.
- Hash per file; unchanged files are skipped; a changed file's sections, blocks, mentions and FTS rows are deleted and rebuilt in one transaction.
- **Re-link on code change.** When a code file is re-indexed, doc mentions that pointed into it lose their `to_symbol_id`; resolve them again by name, as `edges` do.
- **Parsing in the worker thread** with the rest of the indexer. mdast is fast, but a 500-file docs tree must not block the queue.
- Include and exclude globs: add `docs` settings to `refdex.build.json`/project config with defaults (`**/*.md`, `**/*.txt`, excluding `node_modules`, `dist`, `build`, `.git`, `CHANGELOG*` over the size cap).

## Phases

### Phase 0: Baseline and a doc question set

- Pick two corpora: this repo's `docs/` plus `README.md`, and one large public docs-heavy repo.
- Write 20 to 30 questions with known answers and known source sections. Mix: concept lookup, table lookup ("what is the default port"), list lookup ("what are the steps"), cross-file ("where is auth described anywhere"), code-to-doc ("what does the plan say about `IndexQueue`").
- Run the existing bench harness with grep and Read only, and record tokens, tool calls and accuracy. This is the number to beat.
- Done when: the baseline report is committed in `bench/results/`.

### Phase 1: Parse and store

- Docs adapter in `packages/core` (markdown via mdast, text via the heuristics), schema version 9 with the tables above, indexer wiring, watcher and rebuild.
- Unit tests on fixtures: nested headings, setext headings, tables with alignment and empty cells, nested lists, ordered lists, front matter, code fences containing `#` lines (must not become headings), CRLF files, a file with no headings, a file with only headings, very long lines.
- Done when: re-indexing a changed `.md` updates only that file's rows, the line ranges of every section reproduce the file when concatenated, and `npm test` and `npm run check-types` pass with the schema bump.

### Phase 2: Search and the tools

- FTS population with identifier splitting, ranking, packing, and the three tools in `tools.ts` and `mcp.ts`. Usage log entries so the panel/status shows docs calls.
- Done when: a tool-level test returns the expected section for each question in the Phase 0 set, within budget.

### Phase 3: Link docs and code

- `doc_mentions` resolution, `get_context` and `find_references` integration, drift report.
- Done when: `find_references` on `IndexQueue` in this repo lists the plan sections that mention it.

### Phase 4: Measure and tune

- Rerun the Phase 0 set with the new tools available, with and without instructions steering the agent to use them.
- Tune column weights, document-type weights and the budget defaults by looking at misses, not by guessing.
- Done when: the report shows fewer tokens and no loss of accuracy against the Phase 0 baseline, or says honestly where it did not.

### Phase 5: Optional semantic layer (only if Phase 4 shows concept misses)

- Local embedding model (small, CPU, runs in the worker), vectors stored per section (or per chunk) in the same database, hybrid ranking by reciprocal rank fusion with BM25.
- Costs to weigh: model download size, index time, and a second source of ranking to explain. Skip if lexical search with identifier splitting and heading weights is already good.

## Evaluation

| Metric | How |
| --- | --- |
| Tokens per question | Sum of tool-result characters / 4, and the API usage from the transcript, as in `bench/cost.ts` |
| Tool calls per question | From the transcript |
| Accuracy | `bench/grade.ts` against the known answer; also "did the answer cite the right section" |
| Recall at 1 / 3 | Whether the expected section is in the first one or three results of `search_docs`, no agent involved. Cheap to run on every change |
| Agent adoption | How often the agent calls `search_docs` when it could have grepped. If low, the fix is the tool description, not the index |

## Risks and open questions

**Risks**

- **The agent keeps grepping.** Agents default to built-in tools; the code tools needed the "directed" variants in the benchmark for the same reason. Mitigation: concise tool descriptions, server `instructions`, and the project's `CLAUDE.md` line the extension can offer to add.
- **Lexical search misses concepts** ("going cold" vs "idle"). Mitigation: heading weights and path text first; embeddings in Phase 5 only if measured.
- **Index size.** FTS plus block text roughly doubles the doc text. Docs are small next to code; keep the size caps and report totals in the status view.
- **Stale or wrong docs rank high.** The index finds what is written, not what is true. The drift report helps; do not claim more.
- **Schema bump** forces a rebuild for every user; Guava takes 40 s, docs add little. Acceptable, but say so in the changelog.
- **Tool surface growth.** Five code tools plus three doc tools. Watch the measured cost of tool definitions in the benchmark (the "tool search off" runs already do this).

**Open questions**

1. mdast or `markdown-it` for the parser? mdast has richer node positions; `markdown-it` is smaller and faster. Decide with a 20-line spike on the repo's own docs.
2. Should docs be a separate `search_docs` tool or an option on `search_symbols`? A separate tool is clearer to the model; one fewer tool is cheaper. Measure in Phase 4.
3. Which text files count? `.txt` only, or also `.rst`, `.adoc`, `.mdx` and extensionless `README`, `LICENSE`? Start with `.md`, `.markdown`, `.txt`; add the rest when asked.
4. Should the index include docs outside the project root (a user-level `~/.claude/CLAUDE.md`)? Probably not, because the index is per project and shared in the host; leave out.
5. Per-project switch: docs indexing on by default, or opt-in? Default on for `.md`; it is cheap and the user asked for it, but a setting to turn it off is needed.
