// Tolerant JSON extraction for LLM output.
// The Claude call uses structured outputs, so the happy path is a plain
// JSON.parse. The repair steps exist for the cases that still happen in real
// life: a local Ollama model wrapping JSON in ```fences```, a chatty preface,
// smart quotes, or trailing commas.

const REPAIRS = [
  ['strip-code-fence', (t) => {
    const m = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    return m ? m[1] : t;
  }],
  ['slice-outer-object', (t) => {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    return start !== -1 && end > start ? t.slice(start, end + 1) : t;
  }],
  ['normalize-smart-quotes', (t) => t.replace(/[“”„‟]/g, '"').replace(/[‘’]/g, "'")],
  ['remove-trailing-commas', (t) => t.replace(/,\s*([}\]])/g, '$1')],
];

/**
 * Parse JSON from model text. Returns { value, repairs } where `repairs`
 * lists the repair steps that were needed (empty on a clean parse).
 * Throws an Error with a short explanation if nothing works.
 */
export function extractJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Model returned no text to parse as JSON');
  }
  let candidate = text.trim();
  try {
    return { value: JSON.parse(candidate), repairs: [] };
  } catch {
    // fall through to repairs
  }
  const applied = [];
  for (const [name, fn] of REPAIRS) {
    const next = fn(candidate);
    if (next !== candidate) {
      applied.push(name);
      candidate = next.trim();
    }
    try {
      return { value: JSON.parse(candidate), repairs: applied };
    } catch {
      // keep going
    }
  }
  const preview = text.slice(0, 120).replace(/\s+/g, ' ');
  throw new Error(`Could not parse model output as JSON after repairs [${applied.join(', ') || 'none'}]: "${preview}..."`);
}
