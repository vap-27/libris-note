import { describe, expect, it } from 'vitest'
import {
  sanitizePageHtml,
  stripHtmlToText,
  isBlankHtml,
  filterMarkClasses,
  escapeLikeWildcards,
  healEscapedInlineTags,
} from '../../src/lib/sanitize'

describe('isBlankHtml — sweep blankness contract', () => {
  const blank = ['', '   ', '<p><br></p>', '<p><br></p><p><br></p>', '<br>', '&nbsp;', '&#160;', '<p> &nbsp; </p>', '<mark class="ink-hl-yellow"><br></mark>', '<div>\n\t </div>']
  for (const input of blank) {
    it(`blank: ${JSON.stringify(input).slice(0, 40)}`, () => {
      expect(isBlankHtml(input)).toBe(true)
    })
  }
  const kept = ['.', ',', 'a', '<p>.</p>', '<p><mark>x</mark></p>', '&amp;', '0']
  for (const input of kept) {
    it(`kept: ${JSON.stringify(input).slice(0, 40)}`, () => {
      expect(isBlankHtml(input)).toBe(false)
    })
  }
})

describe('sanitizePageHtml — XSS allowlist', () => {
  it('strips scripts, handlers, javascript: URLs and style', () => {
    const out = sanitizePageHtml(
      '<script>alert(1)</script><p onclick="x()">hi</p><a href="javascript:alert(1)">a</a><div style="color:red">d</div><svg><animate/>'
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('style=')
    expect(out).not.toContain('<svg')
    expect(out).toContain('<p>hi</p>')
  })

  it('downgrades h1/h2/h4-h6 to h3 instead of escaping', () => {
    expect(sanitizePageHtml('<h1>A</h1><h5>B</h5>')).toBe('<h3>A</h3><h3>B</h3>')
    expect(sanitizePageHtml('<h3>K</h3>')).toBe('<h3>K</h3>')
  })

  it('unwraps span/font keeping text', () => {
    expect(sanitizePageHtml('<p>a<span style="x" onclick="y">b</span>c</p>')).toBe('<p>abc</p>')
    expect(sanitizePageHtml('x<font color="red">y</font>z')).toBe('xyz')
  })

  it('keeps exactly the palette mark classes', () => {
    for (const c of ['yellow', 'green', 'pink', 'blue', 'purple', 'orange', 'red', 'teal', 'slate', 'stone', 'charcoal']) {
      expect(sanitizePageHtml(`<mark class="ink-hl ink-hl-${c}">h</mark>`)).toBe(
        `<mark class="ink-hl ink-hl-${c}">h</mark>`
      )
    }
    expect(sanitizePageHtml('<mark class="ink-hl evil" onclick="x">h</mark>')).toBe('<mark class="ink-hl">h</mark>')
    expect(sanitizePageHtml('<mark class="evil">h</mark>')).toBe('<mark>h</mark>')
  })

  it('escapes unknown tags and strips comments', () => {
    expect(sanitizePageHtml('<foo>bar</foo><!-- c -->ok')).toBe('&lt;foo&gt;bar&lt;/foo&gt;ok')
  })

  it('heals old escaped spans then unwraps', () => {
    expect(sanitizePageHtml('<p>1 for Index,&lt;span&gt; &lt;/span&gt;</p>')).toBe('<p>1 for Index, </p>')
    // never heals dangerous tags
    expect(healEscapedInlineTags('&lt;script&gt;x&lt;/script&gt;')).toBe('&lt;script&gt;x&lt;/script&gt;')
  })
})

describe('filterMarkClasses', () => {
  it('keeps allowlisted, drops the rest', () => {
    expect(filterMarkClasses('<mark class="ink-hl ink-hl-teal">')).toBe('ink-hl ink-hl-teal')
    expect(filterMarkClasses('<mark class="evil">')).toBe('')
    expect(filterMarkClasses('<mark>')).toBe('')
  })
})

describe('escapeLikeWildcards', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeLikeWildcards('100%_\\x')).toBe('100\\%\\_\\\\x')
    expect(escapeLikeWildcards('plain')).toBe('plain')
  })
})

describe('stripHtmlToText', () => {
  it('reduces residue to empty', () => {
    expect(stripHtmlToText('<p><br></p>')).toBe('')
    expect(stripHtmlToText('<p>hi</p>')).toBe('hi')
  })
})
