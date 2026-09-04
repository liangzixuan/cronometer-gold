export interface ParsedArguments {
  readonly command: readonly string[];
  readonly options: Readonly<Record<string, string | true>>;
  readonly positionals: readonly string[];
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  const command: string[] = [];
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  let readingCommand = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      readingCommand = false;
      const option = token.slice(2);
      const separator = option.indexOf("=");
      const rawName = separator === -1 ? option : option.slice(0, separator);
      const inlineValue = separator === -1 ? undefined : option.slice(separator + 1);
      if (!rawName || Object.hasOwn(options, rawName)) {
        throw new Error(`Invalid or repeated option: ${token}`);
      }
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) throw new Error(`Option --${rawName} requires a value`);
        options[rawName] = inlineValue;
        continue;
      }
      const next = tokens[index + 1];
      if (next && !next.startsWith("--")) {
        options[rawName] = next;
        index += 1;
      } else {
        options[rawName] = true;
      }
      continue;
    }
    if (readingCommand && command.length < 2) {
      command.push(token);
    } else {
      readingCommand = false;
      positionals.push(token);
    }
  }

  return Object.freeze({
    command: Object.freeze(command),
    options: Object.freeze(options),
    positionals: Object.freeze(positionals),
  });
}

export function requiredOption(
  options: Readonly<Record<string, string | true>>,
  name: string,
): string {
  const value = options[name];
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`--${name} requires a non-blank value`);
  }
  return value;
}

export function optionalOption(
  options: Readonly<Record<string, string | true>>,
  name: string,
): string | undefined {
  const value = options[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`--${name} requires a non-blank value`);
  }
  return value;
}

export function flagOption(
  options: Readonly<Record<string, string | true>>,
  name: string,
): boolean {
  const value = options[name];
  if (value === undefined) return false;
  if (value !== true) throw new Error(`--${name} does not accept a value`);
  return true;
}
