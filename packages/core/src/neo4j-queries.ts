import { cypherLiteral } from './cypher-literal.ts';

/**
 * Starter queries for people new to Cypher, stored with each app as (:StarterQuery) nodes (see
 * NEO4J_STARTER_QUERIES) and offered by the IDE plugins. They use the app's name and real names
 * from the code, so each one finds something on its first run and shows what to change.
 */
export interface StarterQuery {
  /** Unique within the app. */
  name: string;
  title: string;
  /** What it shows, in plain words, and what to change to ask something else. */
  description: string;
  /** Neo4j Browser draws `graph` results as nodes and arrows; `table` results are rows. */
  view: 'graph' | 'table';
  cypher: string;
}

/** Real names from a repository for the starter queries. */
export interface StarterExamples {
  /** The repository they come from; the queries about them are scoped to it. */
  repo?: string;
  /** The class or interface used most, counting uses of its members. */
  type?: string;
  /** The method or function called most. */
  method?: string;
  /** The method or function that calls the most others. */
  caller?: string;
  /** The largest file, relative to the root. */
  file?: string;
}

/** Stores the app's starter queries (`$queries`) and removes ones a newer RefDex no longer has. */
export const NEO4J_STARTER_QUERIES = `MATCH (a:App {name: $app})
UNWIND $queries AS q
MERGE (n:RefDex:StarterQuery {app: $app, name: q.name})
SET n += q
MERGE (a)-[:HAS_QUERY]->(n)
WITH a, collect(q.name) AS names
OPTIONAL MATCH (a)-[:HAS_QUERY]->(old:StarterQuery)
WHERE NOT old.name IN names
DETACH DELETE old`;

/**
 * The app's largest repository, by symbols, and how many starter queries the app has. A load
 * rewrites the starter queries only when its repository is the largest or the app has none, so
 * their examples come from the code that has most to show.
 */
export const NEO4J_STARTER_SOURCE = `OPTIONAL MATCH (p:Repository {app: $app}) WHERE p.symbols IS NOT NULL
WITH p ORDER BY p.symbols DESC, p.name LIMIT 1
OPTIONAL MATCH (:App {name: $app})-[:HAS_QUERY]->(q:StarterQuery)
RETURN p.name AS largest, count(q) AS queries`;

/** Lists the starter queries in Neo4j Browser: the one query to remember. */
export const NEO4J_LIST_STARTER_QUERIES = 'MATCH (q:StarterQuery) RETURN q.app AS app, q.title AS title, q.description AS description, q.cypher AS cypher ORDER BY app, q.order';

/** The starter queries of an app, in the order to try them, numbered by `order` when stored. */
export function neo4jStarterQueries(app: string, examples: StarterExamples = {}): (StarterQuery & { order: number })[] {
  const a = cypherLiteral(app);
  const type = examples.type ?? 'Service';
  const method = examples.method ?? 'save';
  const caller = examples.caller ?? method;
  const file = examples.file ?? 'src/index.ts';
  const callable = `m.kind IN ['function', 'method']`;
  // Pattern properties of a symbol or file in the examples' repository.
  const inRepo = (more: string) => `{app: ${a}${examples.repo ? `, repo: ${cypherLiteral(examples.repo)}` : ''}, ${more}}`;
  const where = examples.repo ? ` in ${examples.repo}` : '';
  const queries: StarterQuery[] = [
    {
      name: 'overview', view: 'graph', title: 'Map of the app',
      description: 'The app and its repositories. Click a node to see its properties, such as how many files and symbols a repository has.',
      cypher: `MATCH p = (:App {name: ${a}})-[:HAS_REPOSITORY]->(:Repository)\nRETURN p`,
    },
    {
      name: 'contents', view: 'table', title: 'What each repository contains',
      description: 'How many classes, interfaces, methods, functions and so on each repository has.',
      cypher: `MATCH (s:Symbol {app: ${a}})\nRETURN s.repo AS repository, s.kind AS kind, count(*) AS symbols\nORDER BY repository, symbols DESC`,
    },
    {
      name: 'core', view: 'table', title: 'The most important code',
      description: 'The 25 symbols the rest of the code relies on most: used often, and by code that is itself used often (PageRank, scaled by repository size so repositories compare fairly). A good place to start reading.',
      cypher: `MATCH (r:Repository {app: ${a}})\nMATCH (s:Symbol {app: ${a}, repo: r.name})\nWHERE NOT s.kind IN ['property', 'field']\nRETURN s.repo AS repository, s.qualifiedName AS symbol, s.kind AS kind, s.path AS file, s.startLine AS line\nORDER BY s.pagerank * r.symbols DESC\nLIMIT 25`,
    },
    {
      name: 'file', view: 'graph', title: 'Everything in a file',
      description: `The file ${file} (the largest${where}), with the classes and functions it declares and their members. Change the path to look at another file.`,
      cypher: `MATCH p = (:File ${inRepo(`path: ${cypherLiteral(file)}`)})-[:DECLARES]->(:Symbol)-[:CONTAINS*0..2]->(:Symbol)\nRETURN p`,
    },
    {
      name: 'used-by', view: 'graph', title: 'Where a class is used',
      description: `Everything that calls or refers to ${type} or its members (the most used class or interface${where}). Change the name to look at another one.`,
      cypher: `MATCH p = ()-[:CALLS|REFERENCES]->(:Symbol)<-[:CONTAINS*0..1]-(:Symbol ${inRepo(`name: ${cypherLiteral(type)}`)})\nRETURN p\nLIMIT 100`,
    },
    {
      name: 'callers', view: 'graph', title: 'Who calls a method',
      description: `The callers of ${method} (the most called method or function${where}), and their callers: what a change to it could affect. Change the name to follow another one.`,
      cypher: `MATCH p = ()-[:CALLS*1..2]->(m:Symbol ${inRepo(`name: ${cypherLiteral(method)}`)})\nWHERE ${callable}\nRETURN p\nLIMIT 100`,
    },
    {
      name: 'callees', view: 'graph', title: 'What a method calls',
      description: `What ${caller} calls, two steps deep: the code it depends on (${caller} calls the most other code${where}). Change the name to follow another one.`,
      cypher: `MATCH p = (m:Symbol ${inRepo(`name: ${cypherLiteral(caller)}`)})-[:CALLS*1..2]->(:Symbol)\nWHERE ${callable}\nRETURN p\nLIMIT 100`,
    },
    {
      name: 'hierarchy', view: 'graph', title: 'Class hierarchy',
      description: 'Classes and interfaces with the types they extend or implement. No result means the code doesn\'t use inheritance much.',
      cypher: `MATCH p = (:Symbol {app: ${a}})-[:EXTENDS|IMPLEMENTS*1..3]->(:Symbol)\nRETURN p\nLIMIT 100`,
    },
    {
      name: 'imports', view: 'graph', title: 'Which files depend on which',
      description: 'Files and the files they import. Tightly connected groups are parts of the code that depend on each other.',
      cypher: `MATCH p = (:File {app: ${a}})-[:IMPORTS]->(:File)\nRETURN p\nLIMIT 150`,
    },
    {
      name: 'mutual-imports', view: 'table', title: 'Files that import each other',
      description: 'Pairs of files that import each other, which makes them hard to change or test apart. No result is good news.',
      cypher: `MATCH (f:File {app: ${a}})-[:IMPORTS]->(g:File)-[:IMPORTS]->(f)\nWHERE f.path < g.path\nRETURN f.repo AS repository, f.path AS file, g.path AS imports_and_is_imported_by\nLIMIT 50`,
    },
    {
      name: 'largest-types', view: 'table', title: 'The largest classes',
      description: 'Classes and interfaces with the most members. Very large ones often do too much.',
      cypher: `MATCH (c:Symbol {app: ${a}})-[:CONTAINS]->(m:Symbol)\nWHERE c.kind IN ['class', 'interface']\nRETURN c.repo AS repository, c.qualifiedName AS type, count(m) AS members, c.path AS file\nORDER BY members DESC\nLIMIT 20`,
    },
    {
      name: 'unused', view: 'table', title: 'Code nothing seems to use',
      description: 'Methods and functions that nothing in the index calls or refers to. Check before deleting: calls RefDex could not link (from libraries, frameworks, tests run by name or dynamic code) don\'t count here.',
      cypher: `MATCH (m:Symbol {app: ${a}})\nWHERE ${callable} AND NOT EXISTS { ()-[:CALLS|REFERENCES]->(m) }\nRETURN m.repo AS repository, m.qualifiedName AS symbol, m.path AS file, m.startLine AS line\nORDER BY repository, file, line\nLIMIT 50`,
    },
    {
      name: 'search', view: 'table', title: 'Find code by name',
      description: `Symbols whose name contains "${type}", in any case. Change the text to search for something else.`,
      cypher: `MATCH (s:Symbol {app: ${a}})\nWHERE toLower(s.name) CONTAINS toLower(${cypherLiteral(type)})\nRETURN s.repo AS repository, s.qualifiedName AS symbol, s.kind AS kind, s.path AS file, s.startLine AS line\nORDER BY symbol\nLIMIT 50`,
    },
  ];
  return queries.map((q, i) => ({ ...q, order: i + 1 }));
}

/** All starter queries as one Cypher file, with each one's title and description as comments. */
export function starterQueriesScript(app: string, queries: StarterQuery[]): string {
  return [
    `// RefDex starter queries for the Neo4j app ${JSON.stringify(app)}.`,
    '// Copy one into Neo4j Browser (http://localhost:7474 for a local Neo4j) and run it with Ctrl+Enter.',
    ...queries.map((q, i) => `\n// ${i + 1}. ${q.title} (${q.view})\n// ${q.description}\n${q.cypher};`),
  ].join('\n') + '\n';
}
