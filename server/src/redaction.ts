const SECRET_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|passwd|credential|authorization|bearer|private[_-]?key|access[_-]?key|refresh[_-]?token)/i;
const SECRET_VALUE_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

export function redactSecrets(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : redactSecrets(nested);
    }
    return output;
  }
  return "[UNSUPPORTED]";
}

function redactString(input: string): string {
  let output = input.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
  output = output.replace(
    /\b(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*("[^"]+"|'[^']+'|\S+)/gi,
    "$1=[REDACTED]",
  );
  return output.length > 2000
    ? `${output.slice(0, 2000)}...[TRUNCATED]`
    : output;
}
