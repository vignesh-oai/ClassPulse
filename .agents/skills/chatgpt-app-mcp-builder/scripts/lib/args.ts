export type ParsedArgs = {
  options: Record<string, string | boolean>;
  positionals: string[];
};

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";

    if (!token.startsWith("--") || token === "--") {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    if (!withoutPrefix) {
      continue;
    }

    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      const key = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      if (key) {
        setOption(options, key, value);
      }
      continue;
    }

    if (withoutPrefix.startsWith("no-") && withoutPrefix.length > 3) {
      setOption(options, withoutPrefix.slice(3), false);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      setOption(options, withoutPrefix, next);
      index += 1;
      continue;
    }

    setOption(options, withoutPrefix, true);
  }

  return { options, positionals };
}

export function getStringOption(options: Record<string, string | boolean>, key: string) {
  const value = options[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function getBooleanOption(
  options: Record<string, string | boolean>,
  key: string,
  defaultValue = false,
) {
  const value = options[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
}

function setOption(options: Record<string, string | boolean>, key: string, value: string | boolean) {
  if (!key) {
    return;
  }
  options[key] = value;
}
