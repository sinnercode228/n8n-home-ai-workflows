import { stableUuid } from '../shared/text.js';

// Split household documents into overlapping chunks for embedding.
// Paragraph-aware: we pack whole paragraphs until the size limit, carry a
// short overlap into the next chunk, and remember the nearest Markdown
// heading so citations can say "boiler.md > Annual service".

export function chunkDocument({ path, text }, { maxChars = 1200, overlapChars = 200 } = {}) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks = [];
  let heading = null;
  let current = ''; // text of the chunk being built (may start with overlap)
  let hasNew = false; // true once `current` holds text not already in a previous chunk
  let currentHeading = null;

  const flush = () => {
    if (!hasNew) return;
    const index = chunks.length;
    chunks.push({
      id: stableUuid(`${path}#${index}#${current}`),
      path,
      chunkIndex: index,
      heading: currentHeading,
      text: current.trim(),
    });
    const tail = current.slice(-overlapChars);
    const cut = tail.indexOf(' ');
    current = cut > 0 ? tail.slice(cut + 1) : '';
    hasNew = false;
  };

  for (const para of paragraphs) {
    if (/^#{1,6}\s+/.test(para)) heading = para.split('\n')[0].replace(/^#{1,6}\s+/, '').trim();
    // Very long paragraphs (tables, pasted logs) are split on whitespace.
    const pieces = para.length > maxChars ? para.match(new RegExp(`[\\s\\S]{1,${maxChars - overlapChars}}(?=\\s|$)`, 'g')) || [para] : [para];
    for (const piece of pieces) {
      if (hasNew && current.length + piece.length + 2 > maxChars) flush();
      if (!hasNew) currentHeading = heading;
      current = current ? `${current}\n\n${piece}` : piece;
      hasNew = true;
    }
  }
  flush();
  return chunks;
}

/** Qdrant points + the list of files touched (to delete stale chunks first). */
export function buildQdrantPoints(chunks, embeddings, { batchSize = 64 } = {}) {
  if (chunks.length !== embeddings.length) {
    throw new Error(`Got ${embeddings.length} embeddings for ${chunks.length} chunks`);
  }
  const points = chunks.map((c, i) => {
    const vector = embeddings[i];
    if (!Array.isArray(vector) || vector.length === 0) throw new Error(`Chunk ${c.path}#${c.chunkIndex} has no embedding`);
    return {
      id: c.id,
      vector,
      payload: { path: c.path, chunkIndex: c.chunkIndex, heading: c.heading, text: c.text },
    };
  });
  const batches = [];
  for (let i = 0; i < points.length; i += batchSize) batches.push({ points: points.slice(i, i + batchSize) });
  const paths = [...new Set(chunks.map((c) => c.path))];
  return {
    paths,
    pointCount: points.length,
    deleteRequest: { filter: { must: [{ key: 'path', match: { any: paths } }] } },
    batches,
  };
}
