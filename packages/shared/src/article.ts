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

/**
 * The article's lead: the FULL first paragraph (un-truncated), used verbatim above the
 * AFS unit on the monetized page. Returns `''` when the body has no paragraph. The page
 * renders this as the lead AND drops the matching first body block (see `articleBlocks`)
 * so the opening paragraph is shown exactly once — never duplicated nor lost. The short
 * `articleTeaser()` stays the meta-description-only summary.
 */
export function articleLead(content: string): string {
  return articleParagraphs(content)[0] ?? '';
}

/** A renderable block from the article markdown (headings, paragraphs, lists). */
export type ArticleBlock =
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

/** Strip inline markdown emphasis (**bold**, __bold__, *italic*) to plain text. */
function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .trim();
}

/**
 * Parse the article body (our controlled markdown subset) into typed blocks for safe
 * React rendering — `## ` / `### ` headings, `- `/`* ` bullet lists, `1. ` numbered
 * lists, and paragraphs. No HTML is produced (no injection); inline emphasis markers
 * are stripped to plain text. `#` is treated as `h2` since the page renders the title
 * as the `h1`.
 */
export function articleBlocks(content: string): ArticleBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ArticleBlock[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = (): void => {
    if (para.length) {
      blocks.push({ type: 'p', text: stripInline(para.join(' ')) });
      para = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      const text = stripInline(heading[2]!);
      blocks.push(heading[1]!.length >= 3 ? { type: 'h3', text } : { type: 'h2', text });
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      flushPara();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(stripInline(ordered[1]!));
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(stripInline(bullet[1]!));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}
