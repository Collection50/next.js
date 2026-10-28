import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getRouteCacheKey } from 'next/dist/server/lib/route-cache-key'
import { RouteKind } from 'next/dist/server/route-kind'

// @force-gate start
describe('param-matching-runtime', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  async function render(pathname: string, params: string) {
    const res = await next.fetch(pathname)
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain(`<p id="params">${params}</p>`)
    const marker = html.match(/<p id="shell-marker">([^<]+)<\/p>/)?.[1]
    expect(marker).toBeDefined()
    // Inspect emitted HTML, not the serialized Suspense fallback in Flight.
    return { marker, hasFallback: html.includes('<p id="pending">') }
  }

  async function navigate(pathname: string, params: string) {
    const response = await next.fetch(pathname, { headers: { rsc: '1' } })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain(JSON.stringify({ id: 'params', children: params }))
    return { body }
  }

  async function prerenderHTML(pathname: string, sourceRoute: string) {
    const key = getRouteCacheKey(pathname, {
      kind: RouteKind.APP_PAGE,
      sourceRoute,
    })
    return next.readFile(`.next/server/${key}.html`)
  }

  describe.each(['blocking', 'blocking-no-seed'])('%s', (route) => {
    it('uses one blocking prerender for concurrent cold document and navigation requests', async () => {
      const slug = `navigation-${randomUUID()}`
      const pathname = `/${route}/${slug}`
      const [navigation, document] = await Promise.all([
        navigate(pathname, slug),
        render(pathname, slug),
      ])
      expect(document.hasFallback).toBe(false)
      expect(navigation.body).toContain(document.marker)
      const repeated = await navigate(pathname, slug)
      expect(repeated.body).toContain(document.marker)
      expect(await prerenderHTML(pathname, `/${route}/[slug]/page`)).toContain(
        `<p id="params">${slug}</p>`
      )
    })

    it('prerenders the requested params before serving a cold document', async () => {
      const a = await render(`/${route}/cold-a`, 'cold-a')
      const b = await render(`/${route}/cold-b`, 'cold-b')

      expect(a.hasFallback).toBe(false)
      expect(b.hasFallback).toBe(false)
      expect(a.marker).not.toBe(b.marker)
      expect((await render(`/${route}/cold-a`, 'cold-a')).marker).toBe(a.marker)
    })

    it('shields concurrent cold requests with one concrete prerender', async () => {
      const responses = await Promise.all(
        Array.from({ length: 3 }, () =>
          render(`/${route}/concurrent`, 'concurrent')
        )
      )
      for (const response of responses) {
        expect(response.hasFallback).toBe(false)
        expect(response.marker).toBe(responses[0].marker)
      }
      expect((await render(`/${route}/concurrent`, 'concurrent')).marker).toBe(
        responses[0].marker
      )
    })
  })

  describe.each(['fallback', 'fallback-no-seed'])('%s', (route) => {
    it('upgrades a navigation-selected fallback only when Partial Prefetching is enabled', async () => {
      const slug = `navigation-${randomUUID()}`
      const pathname = `/${route}/${slug}`
      await navigate(pathname, slug)
      const config = await next.getResolvedConfig()
      if (config.partialPrefetching) {
        await retry(async () => {
          const html = await prerenderHTML(pathname, `/${route}/[slug]/page`)
          expect(html).toContain(`<p id="params">${slug}</p>`)
          expect(html).not.toContain('<p id="pending">')
        })
        const document = await render(pathname, slug)
        expect(document.hasFallback).toBe(false)
      } else {
        const document = await render(pathname, slug)
        expect(document.hasFallback).toBe(true)
        const sibling = await render(`/${route}/${slug}-other`, `${slug}-other`)
        expect(sibling.hasFallback).toBe(true)
        expect(sibling.marker).toBe(document.marker)
      }
    })

    it('serves a shared shell and resumes novel params for the first visitor', async () => {
      const a = await render(`/${route}/first-a`, 'first-a')
      const b = await render(`/${route}/first-b`, 'first-b')

      expect(a.hasFallback).toBe(true)
      expect(b.hasFallback).toBe(true)
      expect(a.marker).toBe(b.marker)
    })

    it('upgrades the shell only when Partial Prefetching enables upgrades', async () => {
      const pathname = `/${route}/upgrade`
      const first = await render(pathname, 'upgrade')
      expect(first.hasFallback).toBe(true)

      const config = await next.getResolvedConfig()
      if (config.partialPrefetching) {
        await retry(async () => {
          const upgraded = await render(pathname, 'upgrade')
          expect(upgraded.hasFallback).toBe(false)
          expect(upgraded.marker).not.toBe(first.marker)
        })
      } else {
        const resumed = await render(pathname, 'upgrade')
        expect(resumed.hasFallback).toBe(true)
        expect(resumed.marker).toBe(first.marker)
      }
    })
  })

  it('stores a blocking navigation prerender under the prefix key and renders each dynamic tail per request', async () => {
    const top = `navigation-${randomUUID()}`
    await navigate(`/dynamic/${top}/first`, `${top}/first`)
    const key = `/dynamic/${top}/[bottom]`
    const sourceRoute = '/dynamic/[top]/[bottom]/page'
    const html = await prerenderHTML(key, sourceRoute)
    expect(html).not.toContain(`<p id="params">${top}/first</p>`)
    expect(html).toContain('<p id="pending">')
    await navigate(`/dynamic/${top}/second`, `${top}/second`)
    expect(await prerenderHTML(key, sourceRoute)).toBe(html)
    const document = await render(`/dynamic/${top}/third`, `${top}/third`)
    expect(document.hasFallback).toBe(true)
    expect(await prerenderHTML(key, sourceRoute)).toBe(html)
  })

  it('regenerates an expired navigation shell without resolving its dynamic tail', async () => {
    const top = `expired-navigation-${randomUUID()}`
    const pathname = `/dynamic/${top}/first`
    const sourceRoute = '/dynamic/[top]/[bottom]/page'
    await navigate(pathname, `${top}/first`)
    const shellPathname = `/dynamic/${top}/[bottom]`
    const original = await prerenderHTML(shellPathname, sourceRoute)
    const key = getRouteCacheKey(shellPathname, {
      kind: RouteKind.APP_PAGE,
      sourceRoute,
    })
    const metadataPath = `.next/server/${key}.meta`
    await next.stop()
    const metadata = JSON.parse(await next.readFile(metadataPath))
    const agedTimestamp = Date.now() - 60_000
    metadata.routeCacheLastModified = agedTimestamp
    metadata.cacheControl = { revalidate: 1, expire: 2 }
    await fs.writeFile(
      join(next.testDir, metadataPath),
      JSON.stringify(metadata)
    )
    await next.start({ skipBuild: true })

    await navigate(`/dynamic/${top}/second`, `${top}/second`)
    const regenerated = await prerenderHTML(shellPathname, sourceRoute)
    expect(regenerated).not.toBe(original)
    expect(regenerated).toContain('<p id="pending">')
    expect(regenerated).not.toContain(`<p id="params">${top}/second</p>`)
    expect(
      JSON.parse(await next.readFile(metadataPath)).routeCacheLastModified
    ).toBeGreaterThan(agedTimestamp)
    const document = await render(`/dynamic/${top}/third`, `${top}/third`)
    expect(document.hasFallback).toBe(true)
    expect(await prerenderHTML(shellPathname, sourceRoute)).toBe(regenerated)
  })

  it('starts with concrete outputs for build-time examples', async () => {
    for (const route of ['blocking', 'fallback']) {
      const first = await render(`/${route}/seed`, 'seed')
      expect(first.hasFallback).toBe(false)
      expect((await render(`/${route}/seed`, 'seed')).marker).toBe(first.marker)
    }
  })

  it('blocks for a novel prerenderable prefix but keeps the tail dynamic', async () => {
    const first = await render('/dynamic/top-a/bottom-a', 'top-a/bottom-a')
    const sameTop = await render('/dynamic/top-a/bottom-b', 'top-a/bottom-b')
    const otherTop = await render('/dynamic/top-b/bottom-a', 'top-b/bottom-a')

    // The bottom value is resumed independently on each request, not captured
    // in the cached output for top. A different top needs its own prerender.
    expect(first.marker).toBe(sameTop.marker)
    expect(first.marker).not.toBe(otherTop.marker)
  })
})
