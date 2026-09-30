/**
 * Tolerant extraction of a JSON object from LLM output (code fences, prose
 * wrappers). The result is untrusted and must still be schema-validated.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1].trim();

  for (const attempt of [candidate, extractJsonObject(candidate)]) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next strategy.
    }
  }
  throw new Error(`Model returned invalid JSON. Preview: ${text.slice(0, 200)}`);
}

export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return text.slice(start, index + 1).trim();
  }
  return null;
}
