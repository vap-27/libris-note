import { describe, expect, it } from 'vitest'
import { checkSameOrigin } from '../../src/lib/csrf'

// Plain Request has no Host header (Next.js always sets it in production),
// so tests must supply it — otherwise the gate correctly abstains.
const post = (headers?: Record<string, string>) =>
  new Request('http://localhost:3000/api/pages', {
    method: 'POST',
    headers: { Host: 'localhost:3000', ...headers },
  }) as any

describe('checkSameOrigin — drive-by CSRF gate', () => {
  it('allows headerless clients (curl/jobs)', () => {
    expect(checkSameOrigin(post())).toBeNull()
  })

  it('allows matching Origin', () => {
    expect(checkSameOrigin(post({ Origin: 'http://localhost:3000' }))).toBeNull()
  })

  it('refuses mismatched Origin', () => {
    const res = checkSameOrigin(post({ Origin: 'https://evil.example' }))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('refuses mismatched Referer (form navigation)', () => {
    const res = checkSameOrigin(post({ Referer: 'https://evil.example/submit' }))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('refuses garbage origin', () => {
    const res = checkSameOrigin(post({ Origin: '::::' }))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })
})
