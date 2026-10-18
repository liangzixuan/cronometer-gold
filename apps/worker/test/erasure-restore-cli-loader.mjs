// Controlled process fixture: the real CLI and storage configuration run; no database opens.
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";

const entry = pathToFileURL(process.argv[1]).href;
const database = `
const wait = phase => new Promise(resolve => {
  const accept = message => {
    if (message === "release-" + phase) {
      process.removeListener("message", accept);
      if (phase === "cleanup") process.disconnect();
      resolve();
    }
  };
  process.on("message", accept);
  process.send(phase);
});
export const createDatabaseFromEnvironment = () => ({ destroy: () => wait("cleanup") });
export const assertDatabaseMigrationLedgerReady = () => wait("migration");
export const assertDatabaseReady = () => { throw new Error("Cancelled replay must not reach readiness"); };
export const completeDatabaseRestoreReplayAttestation = assertDatabaseReady;
export const prepareDatabaseRestoreReplaySession = assertDatabaseReady;
export const reconcileErasedAccountRows = assertDatabaseReady;
export const replayExternalErasureLedgerEntry = assertDatabaseReady;
`;
process.on("message", (message) => {
  if (message === "listeners")
    process.send({
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    });
});
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === entry && specifier === "@nutrition-tracker/db")
      return { url: `data:text/javascript,${encodeURIComponent(database)}`, shortCircuit: true };
    if (context.parentURL === entry && specifier.startsWith("./"))
      return next(new URL(`../dist/${specifier.slice(2)}`, entry).href, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === entry)
      return {
        format: "module",
        shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(process.argv[1], "utf8"), { mode: "strip" }),
      };
    return next(url, context);
  },
});
