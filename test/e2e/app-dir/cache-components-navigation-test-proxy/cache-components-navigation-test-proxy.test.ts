import { nextTestSetup } from 'e2e-utils'
import { createProxyServer } from 'next/experimental/testmode/proxy'
import { randomUUID } from 'node:crypto'
import { retry } from 'next-test-utils'
import { getRouteCacheKey } from 'next/dist/server/lib/route-cache-key'
import { RouteKind } from 'next/dist/server/route-kind'

// The test proxy disables the self-hosted ISR cache.
// @force-gate start
describe('Cache Components navigation with the test proxy', () => {
  const { next } = nextTestSetup({ files: __dirname })

  it('renders cold navigations dynamically without a prerender when the test proxy disables ISR', async () => {
    const dynamicRequests = new Set<string>()
    const cachedRequests = new Set<string>()
    const pending = new Map<string, () => void>()
    const proxy = await createProxyServer({
      onFetch: async (testData, request) => {
        const url = new URL(request.url)
        const slug = url.searchParams.get('slug')!
        if (url.pathname === '/dynamic') {
          dynamicRequests.add(slug)
          pending.get(slug)?.()
          return new Response(`dynamic:${testData}`)
        }
        if (url.pathname === '/cached') {
          cachedRequests.add(slug)
          if (!dynamicRequests.has(slug)) {
            // A prerender cannot reach the request-time data that releases this
            // fetch. The foreground RSC render must run both components.
            await new Promise<void>((resolve) => pending.set(slug, resolve))
          }
          return new Response(`cached:${testData}`)
        }
        throw new Error(`Unexpected test proxy request: ${request.url}`)
      },
    })
    try {
      for (let index = 0; index < 2; index++) {
        const slug = `navigation-${randomUUID()}`
        const response = await next.fetch(`/${slug}`, {
          headers: {
            rsc: '1',
            'next-test-proxy-port': String(proxy.port),
            'next-test-data': slug,
          },
        })
        expect(response.status).toBe(200)
        const body = await response.text()
        expect(body).toContain(`cached:${slug}`)
        expect(body).toContain(`dynamic:${slug}`)
        expect(cachedRequests.has(slug)).toBe(true)
        expect(dynamicRequests.has(slug)).toBe(true)
        const key = getRouteCacheKey(`/${slug}`, {
          kind: RouteKind.APP_PAGE,
          sourceRoute: '/[slug]/page',
        })
        expect(await next.hasFile(`.next/server/${key}.meta`)).toBe(false)
      }
    } finally {
      pending.forEach((resolve) => resolve())
      proxy.close()
    }
  })

  it('keeps concurrent RSC navigations to the same URL separate when their test-proxy data differs', async () => {
    const pending = new Map<string, () => void>()
    const proxy = await createProxyServer({
      onFetch: async (testData, request) => {
        const url = new URL(request.url)
        if (url.pathname === '/cached') {
          return new Response('Cached value')
        }
        if (url.pathname === '/dynamic') {
          return new Promise<Response>((resolve) => {
            pending.set(testData, () =>
              resolve(new Response(`dynamic:${testData}`))
            )
          })
        }
        throw new Error(`Unexpected test proxy request: ${request.url}`)
      },
    })
    const slug = `concurrent-${randomUUID()}`
    const testData = ['first', 'second']
    const requests = testData.map((value) =>
      next
        .fetch(`/${slug}`, {
          headers: {
            rsc: '1',
            'next-test-proxy-port': String(proxy.port),
            'next-test-data': value,
          },
        })
        .then(async (response) => ({
          status: response.status,
          body: await response.text(),
        }))
    )
    try {
      // Both request-time fetches must start before either response completes.
      await retry(() => {
        expect([...pending.keys()].sort()).toEqual(testData)
      })
      pending.forEach((resolve) => resolve())
      const responses = await Promise.all(requests)
      for (const [index, response] of responses.entries()) {
        expect(response.status).toBe(200)
        expect(response.body).toContain(`dynamic:${testData[index]}`)
        expect(response.body).not.toContain(`dynamic:${testData[1 - index]}`)
      }
    } finally {
      pending.forEach((resolve) => resolve())
      await Promise.allSettled(requests)
      proxy.close()
    }
  })

  it('renders concrete dynamic tail params for RSC navigations when the test proxy disables ISR', async () => {
    const one = `navigation-${randomUUID()}`
    for (const two of ['first', 'second']) {
      const response = await next.fetch(`/a/${one}/${two}`, {
        headers: { rsc: '1' },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/x-component')
      const body = await response.text()
      expect(body).toContain(
        JSON.stringify({ id: 'one-value', children: `one:${one}` })
      )
      expect(body).toContain(
        JSON.stringify({ id: 'two-value', children: `two:${two}` })
      )
      expect(body).not.toContain('%%drp:')
    }
  })
})
