/** Turn display-oriented Markdown into natural speech without reading syntax or URLs. */
export function markdownToSpeechText(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' Code block omitted from speech. ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' link ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~`>|]/g, '')
    .replace(/&amp;/g, ' and ')
    .replace(/&lt;/g, ' less than ')
    .replace(/&gt;/g, ' greater than ')
    .replace(/&quot;/g, ' quote ')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keep utterances short enough for browser engines that stall on long text,
 * preferring sentence and clause boundaries without losing any spoken words.
 */
export function chunkSpeechText(text, maxChars = 240) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const units = clean.match(/[^.!?;:]+[.!?;:]?\s*/g) || [clean];
  const chunks = [];
  let current = '';

  const pushLong = (value) => {
    const words = value.trim().split(/\s+/);
    let part = '';
    for (const word of words) {
      if (part && `${part} ${word}`.length > maxChars) {
        chunks.push(part);
        part = word;
      } else {
        part = part ? `${part} ${word}` : word;
      }
    }
    return part;
  };

  for (const raw of units) {
    const unit = raw.trim();
    if (!unit) continue;
    const candidate = current ? `${current} ${unit}` : unit;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = unit.length > maxChars ? pushLong(unit) : unit;
  }
  if (current) chunks.push(current);
  return chunks;
}
