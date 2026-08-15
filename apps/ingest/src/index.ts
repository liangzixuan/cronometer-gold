import { runCommand } from "./run.js";

const exitCode = await runCommand(process.argv.slice(2), {
  environment: process.env,
  writeError: (value) => process.stderr.write(value),
  writeOutput: (value) => process.stdout.write(value),
});
process.exitCode = exitCode;
