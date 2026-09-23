// node:sqlite prints an ExperimentalWarning on load. The daemon's stderr is visible to MCP
// clients, so drop that one warning. Must be imported before anything that loads node:sqlite.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (message.includes('SQLite is an experimental feature')) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
