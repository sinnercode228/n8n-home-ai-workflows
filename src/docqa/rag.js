import { cleanText, clip } from '../shared/text.js';
import { readLlmText } from '../shared/llm-response.js';

// Retrieval-augmented answers with citations, entirely on the local network:
// question -> Ollama embedding -> Qdrant search -> Ollama chat -> citations.

export function normalizeQuestion(input) {
  const body = input?.body ?? input ?? {};
  const question = cleanText(body.question ?? body.q ?? body.Question);
  if (!question) return { ok: false, status: 400, error: 'Send JSON like {"question": "When is the boiler service due?"}' };
  if (question.length > 1000) return { ok: false, status: 400, error: 'Question is too long (max 1000 characters)' };
  const topK = Math.min(Math.max(Number(body.topK) || 0, 0), 12) || null;
  return { ok: true, question, topK };
}

/**
 * @param {string} question
 * @param {object[]} hits  Qdrant search results: { id, score, payload: { path, heading, text } }
 * @param {object} config
 */
export function buildRagRequest(question, hits, config = {}) {
  const minScore = Number(config.minScore ?? 0.35);
  const sources = (Array.isArray(hits) ? hits : [])
    .filter((h) => h && h.payload && typeof h.score === 'number' && h.score >= minScore)
    .map((h, i) => ({
      n: i + 1,
      path: h.payload.path,
      heading: h.payload.heading || null,
      chunkIndex: h.payload.chunkIndex,
      score: Math.round(h.score * 1000) / 1000,
      text: h.payload.text,
    }));

  if (sources.length === 0) return { hasSources: false, sources: [] };

  const context = sources
    .map((s) => `[${s.n}] ${s.path}${s.heading ? ` > ${s.heading}` : ''}\n${s.text}`)
    .join('\n\n---\n\n');

  const system = `You answer questions about a household's private documents.
Answer only from the numbered sources. After every sentence that uses a source, cite it like [1] or [2][3].
If the sources do not contain the answer, reply exactly: "I couldn't find that in the documents."
Be brief: at most 5 sentences. Never guess dates, amounts, policy numbers or phone numbers.`;

  return {
    hasSources: true,
    sources,
    request: {
      model: config.chatModel || 'llama3.1:8b',
      stream: false,
      options: { temperature: 0.1, num_ctx: 8192 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Sources:\n\n${context}\n\nQuestion: ${question}` },
      ],
    },
  };
}

/**
 * Map [n] markers in the answer to sources. Citations to sources that do not
 * exist are removed (small local models sometimes invent "[7]").
 */
export function formatAnswer(llmResponse, sources, question) {
  const read = readLlmText(llmResponse);
  if (!read.ok) return { ok: false, question, error: read.error, answer: null, citations: [] };

  const valid = new Set(sources.map((s) => s.n));
  const invalid = new Set();
  const used = new Set();
  const answer = read.text
    .replace(/\[(\d+)\]/g, (m, d) => {
      const n = Number(d);
      if (valid.has(n)) {
        used.add(n);
        return m;
      }
      invalid.add(n);
      return '';
    })
    .replace(/[ \t]+([.,;:])/g, '$1')
    .trim();

  const notFound = /couldn't find that in the documents/i.test(answer);
  const citations = sources
    .filter((s) => used.has(s.n))
    .map((s) => ({ n: s.n, path: s.path, heading: s.heading, score: s.score, excerpt: clip(s.text, 240) }));

  return {
    ok: true,
    question,
    answer,
    grounded: !notFound && citations.length > 0,
    citations,
    warnings: [
      ...(invalid.size ? [`Removed citations to non-existent sources: ${[...invalid].join(', ')}`] : []),
      ...(!notFound && citations.length === 0 ? ['Answer has no citations - treat it with caution'] : []),
    ],
    model: read.model,
  };
}
