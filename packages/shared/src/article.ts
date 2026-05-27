/**
 * The lander teaser: the article's first paragraph, capped at `maxWords` AND
 * `maxChars` (spec §5.5: ≤100 words / ≤300 chars), trimmed on a word boundary
 * with an ellipsis when truncated. This is the short intro shown above the AFS
 * search-ads widget on the monetized article page.
 */
export function articleTeaser(content: string, maxWords = 100, maxChars = 300): string {
  const firstParagraph = content.trim().split(/\n\s*\n/)[0]?.trim() ?? '';
  if (!firstParagraph) return '';

  let truncated = false;
  let words = firstParagraph.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    words = words.slice(0, maxWords);
    truncated = true;
  }
  let text = words.join(' ');

  if (text.length > maxChars) {
    // Cut at maxChars, then back off to the last whole word.
    const hard = text.slice(0, maxChars);
    const lastSpace = hard.lastIndexOf(' ');
    text = (lastSpace > 0 ? hard.slice(0, lastSpace) : hard).trimEnd();
    truncated = true;
  }
  return truncated ? `${text}…` : text;
}

/** Split article body into paragraphs (blank-line separated), dropping empties. */
export function articleParagraphs(content: string): string[] {
  return content
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
