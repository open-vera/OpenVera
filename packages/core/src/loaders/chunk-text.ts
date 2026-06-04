/**
 * Split text into overlapping chunks, breaking at paragraph/sentence boundaries.
 */
export function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    if (end < text.length) {
      const slice = text.slice(start, end);
      const paragraphBreak = slice.lastIndexOf("\n\n");
      const sentenceBreak = slice.lastIndexOf(". ");

      if (paragraphBreak > chunkSize * 0.5) {
        end = start + paragraphBreak + 2;
      } else if (sentenceBreak > chunkSize * 0.5) {
        end = start + sentenceBreak + 2;
      }
    }

    chunks.push(text.slice(start, end).trim());

    const nextStart = end - overlap;
    if (nextStart <= start) {
      start = end;
    } else {
      start = nextStart;
    }
  }

  return chunks.filter((c) => c.length > 0);
}
