/**
 * Minimal isomorphic HTML sanitizer (H-1).
 *
 * No external dependency: allowlist-based, works on server (Node) and client.
 * For page body HTML produced by the contentEditable editor we:
 *  - drop entirely-dangerous elements (script/style/iframe/object/embed/link/meta/svg/math/form/inputs/...)
 *  - strip event-handler attributes (on*), javascript:/data:text/html/vbscript: URLs, style attributes
 *  - keep only a small set of formatting tags the editor actually emits
 *
 * This is intentionally strict. Anything not allowlisted is escaped, not passed through.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'b',
  'i',
  'u',
  's',
  'strong',
  'em',
  'mark',
  'h3',
  'ul',
  'ol',
  'li',
  'blockquote',
  'div',
])

const DANGEROUS_TAG_RE =
  /<\/?\s*(script|style|iframe|object|embed|link|meta|svg|math|form|input|textarea|button|select|option|frame|frameset|base|applet|audio|video|source|track|canvas|noscript|template)\b[^>]*>?/gi

const EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const JS_URL_RE = /\s+(href|src|xlink:href|action)\s*=\s*("|')?\s*(javascript|data\s*:\s*text\/html|vbscript)\s*:[^>"'\s]*/gi
const STYLE_ATTR_RE = /\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * Heal previously-escaped inline tags: older saves contain literal
 * `&lt;span&gt;` text (visible code in the UI) because the sanitizer used to
 * escape unknown tags. Convert span/font entities back to real tags FIRST so
 * the normal pipeline unwraps them into clean text below. Only span/font —
 * never script-like tags.
 */
export function healEscapedInlineTags(html: string): string {
  return String(html ?? '').replace(/&lt;(\/?)(span|font)\b([^&]*?)&gt;/gi, '<$1$2$3>')
}

/** Inline formatting tags that carry no meaning here: drop tag, keep text. */
const UNWRAP_TAG_RE = /<\/?\s*(span|font)\b[^>]*>/gi

/** Only the editor's own highlighter classes survive on <mark>. */
const MARK_CLASS_RE = /^ink-hl(-(yellow|green|pink|blue|purple|orange|red|teal|slate|stone|charcoal))?$/

export function filterMarkClasses(tagHtml: string): string {
  const raw = tagHtml.match(/\bclass\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i)?.[1] ?? ''
  const cls = raw.replace(/^['"]|['"]$/g, '')
  return cls
    .split(/\s+/)
    .filter((c) => MARK_CLASS_RE.test(c))
    .join(' ')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Sanitize editor HTML. Keeps allowlisted tags (attributes stripped except
 * plain <br>), escapes everything else.
 */
export function sanitizePageHtml(html: string, maxLen = 20000): string {
  if (!html) return ''
  let out = String(html).slice(0, maxLen + 4096)
  out = healEscapedInlineTags(out)
  out = stripComments(out)
  out = out.replace(DANGEROUS_TAG_RE, '')
  out = out.replace(EVENT_ATTR_RE, '')
  out = out.replace(JS_URL_RE, '')
  out = out.replace(STYLE_ATTR_RE, '')
  // The editor only emits h3 and the allowlist keeps only h3: downgrade any
  // other heading level instead of escaping it into visible literal text.
  out = out.replace(/<\s*(\/?)\s*h[12456]\b[^>]*>/gi, (_m, close: string) =>
    close ? '</h3>' : '<h3>'
  )

  // Unwrap spans/fonts (paste/execCommand residue): visible text stays, the
  // tag — and any event-handler/style junk riding on it — goes.
  out = out.replace(UNWRAP_TAG_RE, '')
  // Walk tags: keep allowlisted open/close tags (no attributes, except the
  // highlighter palette classes on <mark>), escape the rest.
  out = out.replace(/<\/?\s*([a-zA-Z0-9]+)\b[^>]*>/g, (m, tag: string) => {
    const t = String(tag).toLowerCase()
    if (ALLOWED_TAGS.has(t)) {
      if (t === 'br') return '<br>'
      const isClose = /^<\s*\//.test(m)
      if (!isClose && t === 'mark') {
        const kept = filterMarkClasses(m)
        return kept ? `<mark class="${kept}">` : '<mark>'
      }
      return isClose ? `</${t}>` : `<${t}>`
    }
    return escapeHtml(m)
  })

  return out.slice(0, maxLen)
}

/** Escape plain text for interpolation into <p>...</p> (PageFace fix). */
export function escapeForParagraph(text: string): string {
  return escapeHtml(text)
}

/** Convert plain-text newlines to safe <p> HTML (no raw interpolation). */
export function plainTextToSafeHtml(text: string): string {
  const lines = String(text ?? '').split('\n')
  return lines
    .map((line) => (line.trim() === '' ? '<p><br></p>' : `<p>${escapeHtml(line)}</p>`))
    .join('')
}

/**
 * Plain-text view of editor HTML for blankness checks. ContentEditable
 * residue like "<p><br></p>", "<br>" or "&nbsp;" renders as NOTHING — it must
 * count as blank or ghost pages accumulate forever (and a tilde of markup
 * must never protect a page the user sees as empty).
 */
export function stripHtmlToText(html: string | null | undefined): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#0*160;?/gi, ' ')
    .trim()
}

export function isBlankHtml(content: string | null | undefined): boolean {
  return stripHtmlToText(content).length === 0
}

/** Truncate + strip control chars for log lines (H-3 hardening). */
export function sanitizeLogText(text: string, maxLen = 300): string {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]+/g, '')
    .trim()
    .slice(0, maxLen)
}

/** Escape SQL LIKE wildcards for parameterized LIKE queries (L-3). */
export function escapeLikeWildcards(q: string): string {
  return String(q).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}
