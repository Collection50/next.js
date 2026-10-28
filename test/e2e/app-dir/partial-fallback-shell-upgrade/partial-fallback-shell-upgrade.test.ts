import cheerio from 'cheerio'
import { randomUUID } from 'crypto'
import { nextTestSetup } from 'e2e-utils'
import { splitResponseWithPPRSentinel } from 'e2e-utils/ppr'
import { retry, waitFor } from 'next-test-utils'
import path from 'path'
import { getRouteCacheKey } from 'next/dist/server/lib/route-cache-key'
import { RouteKind } from 'next/dist/server/route-kind'
import { createRouterAct } from 'router-act'

type NextInstance = ReturnType<typeof nextTestSetup>['next']

function createSplitHTMLFetcher(next: NextInstance) {
  return async function fetchSplitHTML(pathname: string) {
    const response = await next.fetch(pathname)
    expect(response.status).toBe(200)

    const [staticPart, dynamicPart] = await splitResponseWithPPRSentinel(
      async () => {
        if (!response.body) {
          throw new Error(`Expected a streamed response body for ${pathname}`)
        }

        return response.body
      }
    )

    return {
      response,
      dynamicPart,
      static$: cheerio.load(staticPart),
    }
  }
}

async function navigate(next: NextInstance, pathname: string, value: string) {
  const response = await next.fetch(pathname, { headers: { rsc: '1' } })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/x-component')
  expect(await response.text()).toContain(`"children":${JSON.stringify(value)}`)
}

async function expectClientParamsNavigation(next: NextInstance) {
  for (const slug of ['first', 'second']) {
    let act: ReturnType<typeof createRouterAct>
    const documents: string[] = []
    const responses: number[] = []
    const target = `/client-params/${slug}`
    const browser = await next.browser('/client-params', {
      beforePageLoad(page) {
        act = createRouterAct(page)
        page.on('request', (request) => {
          if (request.isNavigationRequest()) {
            documents.push(new URL(request.url()).pathname)
          }
        })
        page.on('response', (response) => {
          const request = response.request()
          if (
            new URL(request.url()).pathname === target &&
            request.headers().rsc
          ) {
            responses.push(response.status())
          }
        })
      },
    })
    try {
      await act(() => browser.elementById(`client-link-${slug}`).click())
      expect(await browser.elementById('client-param').text()).toBe(slug)
      expect(responses.length).toBeGreaterThan(0)
      for (const status of responses) {
        expect(status).toBe(200)
      }
      expect(documents).toEqual(['/client-params'])
    } finally {
      await browser.close()
    }
  }
}

async function waitForPrerender(
  next: NextInstance,
  pathname: string,
  sourceRoute: string
) {
  const key = getRouteCacheKey(pathname, {
    kind: RouteKind.APP_PAGE,
    sourceRoute,
  })
  await retry(async () => {
    expect(await next.hasFile(`.next/server/${key}.meta`)).toBe(true)
  })
}

// The legacy Vercel builder does not implement the Cache Components shell
// eligibility and upgrade behavior asserted here.
// @force-gate !deploy || adapter
describe('partial-fallback-shell-upgrade', () => {
  const { next, isNextDev } = nextTestSetup({
    // Deployed shell upgrades require `partialFallback` metadata, which the
    // adapter only emits when Partial Prefetching is enabled in the fixture.
    files: path.join(__dirname, 'fixtures', 'default'),
  })

  if (isNextDev) {
    it('skipped in dev', () => {})
    return
  }

  const fetchSplitHTML = createSplitHTMLFetcher(next)

  it('navigates through a fully static fallback without a document reload when only a Client Component reads params', async () => {
    await expectClientParamsNavigation(next)
  })

  // These assertions observe the navigation's upgrade without another request.
  // @force-gate start
  describe('navigation-triggered fallback upgrades', () => {
    it('upgrades a shared fallback to a fully static route shell after a navigation', async () => {
      const slug = `navigation-${randomUUID()}`
      await navigate(next, `/${slug}`, slug)
      await waitForPrerender(next, `/${slug}`, '/[slug]/page')
      const result = await fetchSplitHTML(`/${slug}`)
      expect(result.static$('#slug').text()).toBe(slug)
      expect(result.static$('#fallback').length).toBe(0)
    })

    it('upgrades a prefix after a navigation and keeps the remaining param dynamic', async () => {
      const one = `navigation-${randomUUID()}`
      await navigate(next, `/prefix/${one}/first`, 'first')
      await waitForPrerender(
        next,
        `/prefix/${one}/[two]`,
        '/prefix/[one]/[two]/page'
      )
      const result = await fetchSplitHTML(`/prefix/${one}/second`)
      expect(result.static$('#one').text()).toBe(one)
      expect(result.static$('#two').length).toBe(0)
      expect(result.static$('#two-fallback').text()).toBe('loading two...')
      expect(result.dynamicPart).toContain('<div id="two">second</div>')
      expect(result.dynamicPart).not.toContain('<div id="two">first</div>')
    })

    it('upgrades a required fallback after a navigation and keeps request-time content dynamic', async () => {
      const bottom = `navigation-${randomUUID()}`
      const pathname = `/mixed/short/${bottom}`
      await navigate(next, pathname, bottom)
      await waitForPrerender(next, pathname, '/mixed/[top]/[bottom]/page')
      const result = await fetchSplitHTML(pathname)
      expect(result.static$('#top').text()).toBe('short')
      expect(result.static$('#bottom').text()).toBe(bottom)
      expect(result.static$('#dynamic').length).toBe(0)
      expect(result.dynamicPart).toContain(
        '<div id="dynamic">Dynamic content</div>'
      )
    })
  })

  it('keeps a fallback shared after a navigation when no params are prerenderable', async () => {
    await navigate(next, '/no-gsp/navigation-first', 'navigation-first')
    for (const slug of ['navigation-first', 'navigation-second']) {
      const result = await fetchSplitHTML(`/no-gsp/${slug}`)
      expect(result.static$('#slug').length).toBe(0)
      expect(result.static$('#fallback').text()).toBe('loading...')
      expect(cheerio.load(result.dynamicPart)('#slug').text()).toBe(slug)
    }
  })

  it('should upgrade the fallback shell to a route shell', async () => {
    const pathname = '/two'
    let $ = await next.render$(pathname)
    expect($('#fallback').text()).toBe('loading...')
    expect($('#slug').closest('[hidden]').length).toBe(1)

    await retry(async () => {
      $ = await next.render$(pathname)
      expect($('#slug').closest('[hidden]').length).toBe(0)
      expect($('#fallback').length).toBe(0)
    })
  })

  it('should not upgrade a route shell when no params were prerendered', async () => {
    const pathname = '/no-gsp/two'
    const start = Date.now()

    await retry(
      async () => {
        const $ = await next.render$(pathname)
        expect($('#fallback').text()).toBe('loading...')
        expect($('#slug').closest('[hidden]').length).toBe(1)

        if (Date.now() - start < 5000) {
          throw new Error('continue polling fallback shell')
        }
      },
      6000,
      500,
      'no-gsp fallback shell should remain unupgraded'
    )
  })

  it('should upgrade a generic shell into the most specific prerendered shell', async () => {
    const firstResult = await fetchSplitHTML('/prefix/c/foo')

    expect(firstResult.response.status).toBe(200)
    expect(firstResult.static$('#one').length).toBe(0)
    expect(firstResult.static$('#one-fallback').text()).toBe('loading one...')
    expect(firstResult.static$('#two-fallback').length).toBe(0)
    expect(firstResult.static$('#two').length).toBe(0)
    expect(firstResult.dynamicPart).toContain('<div id="one">c</div>')
    expect(firstResult.dynamicPart).toContain('<div id="two">foo</div>')

    await retry(async () => {
      const secondResult = await fetchSplitHTML('/prefix/c/bar')

      expect(secondResult.response.status).toBe(200)
      expect(secondResult.static$('#one').text()).toBe('c')
      expect(secondResult.static$('#one-fallback').length).toBe(0)
      expect(secondResult.static$('#two-fallback').text()).toBe(
        'loading two...'
      )
      expect(secondResult.static$('#two').length).toBe(0)
      expect(secondResult.dynamicPart).toContain('<div id="two">bar</div>')
      expect(secondResult.dynamicPart).not.toContain('<div id="two">foo</div>')
    })
  })

  it('should let a segment prefetch trigger the background shell upgrade', async () => {
    const prefetchResponse = await next.fetch('/prefix/z/foo', {
      headers: {
        rsc: '1',
        'next-router-prefetch': '1',
        'next-router-segment-prefetch': '/_tree',
      },
    })

    expect(prefetchResponse.status).toBe(200)

    // Wait a moment to let the background upgrade to finish
    await waitFor(3000)

    const result = await fetchSplitHTML('/prefix/z/bar')

    expect(result.response.status).toBe(200)
    expect(result.static$('#one').text()).toBe('z')
    expect(result.static$('#one-fallback').length).toBe(0)
    expect(result.static$('#two-fallback').text()).toBe('loading two...')
    expect(result.static$('#two').length).toBe(0)
    expect(result.dynamicPart).toContain('<div id="two">bar</div>')
    expect(result.dynamicPart).not.toContain('<div id="two">foo</div>')
  })

  it('should upgrade a required fallback shell with mixed generateStaticParams lengths', async () => {
    // A second cold path must still use the required source shell after the
    // first exact path completes.
    for (const bottom of [`first-${randomUUID()}`, `second-${randomUUID()}`]) {
      const pathname = `/mixed/short/${bottom}`
      const firstResult = await fetchSplitHTML(pathname)

      expect(firstResult.static$('#top').text()).toBe('short')
      expect(firstResult.static$('#top-fallback').length).toBe(0)
      expect(firstResult.static$('#bottom').length).toBe(0)
      expect(firstResult.static$('#bottom-fallback').text()).toBe(
        'loading bottom...'
      )
      expect(firstResult.dynamicPart).toContain(
        `<div id="bottom">${bottom}</div>`
      )
      expect(firstResult.static$('#dynamic').length).toBe(0)
      expect(firstResult.static$('#dynamic-fallback').text()).toBe(
        'loading dynamic...'
      )
      expect(firstResult.dynamicPart).toContain(
        '<div id="dynamic">Dynamic content</div>'
      )

      await retry(async () => {
        const completedResult = await fetchSplitHTML(pathname)

        expect(completedResult.static$('#top').text()).toBe('short')
        expect(completedResult.static$('#top-fallback').length).toBe(0)
        expect(completedResult.static$('#bottom').text()).toBe(bottom)
        expect(completedResult.static$('#bottom-fallback').length).toBe(0)
        expect(completedResult.dynamicPart).not.toContain(
          `<div id="bottom">${bottom}</div>`
        )
        expect(completedResult.static$('#dynamic').length).toBe(0)
        expect(completedResult.static$('#dynamic-fallback').text()).toBe(
          'loading dynamic...'
        )
        expect(completedResult.dynamicPart).toContain(
          '<div id="dynamic">Dynamic content</div>'
        )
      })
    }
  })

  it('should not keep upgrading once only fully dynamic params remain', async () => {
    const firstResult = await fetchSplitHTML('/prefix/b/foo')
    const start = Date.now()

    expect(firstResult.response.status).toBe(200)
    expect(firstResult.static$('#one').text()).toBe('b')
    expect(firstResult.static$('#one-fallback').length).toBe(0)
    expect(firstResult.static$('#two-fallback').text()).toBe('loading two...')
    expect(firstResult.static$('#two').length).toBe(0)
    expect(firstResult.dynamicPart).toContain('<div id="two">foo</div>')

    await retry(
      async () => {
        const secondResult = await fetchSplitHTML('/prefix/b/bar')

        expect(secondResult.response.status).toBe(200)
        expect(secondResult.static$('#one').text()).toBe('b')
        expect(secondResult.static$('#one-fallback').length).toBe(0)
        expect(secondResult.static$('#two-fallback').text()).toBe(
          'loading two...'
        )
        expect(secondResult.static$('#two').length).toBe(0)
        expect(secondResult.dynamicPart).toContain('<div id="two">bar</div>')
        expect(secondResult.dynamicPart).not.toContain(
          '<div id="two">foo</div>'
        )

        if (Date.now() - start < 5000) {
          throw new Error('continue polling more complete shell')
        }
      },
      6000,
      500,
      'shell should remain partial when remaining params are dynamic'
    )
  })
})

// The legacy Vercel builder does not implement the Cache Components shell
// eligibility and upgrade behavior asserted here.
// @force-gate !deploy || adapter
describe('partial-fallback-shell-upgrade - partialPrefetching disabled', () => {
  const { next, isNextDev, isNextDeploy } = nextTestSetup({
    files: path.join(__dirname, 'fixtures', 'partial-prefetching-disabled'),
  })

  if (isNextDev) {
    it('skipped in dev', () => {})
    return
  }

  const fetchSplitHTML = createSplitHTMLFetcher(next)

  it('navigates through a fully static fallback without a document reload when only a Client Component reads params', async () => {
    await expectClientParamsNavigation(next)
  })

  it('keeps a fallback shared after a navigation when Partial Prefetching is disabled', async () => {
    const slug = `navigation-${randomUUID()}`
    await navigate(next, `/${slug}`, slug)
    for (const value of [slug, `${slug}-other`]) {
      const result = await fetchSplitHTML(`/${value}`)
      expect(result.static$('#slug').length).toBe(0)
      expect(result.static$('#fallback').text()).toBe('loading...')
      expect(cheerio.load(result.dynamicPart)('#slug').text()).toBe(value)
    }
  })

  it('keeps a generic fallback shared after a navigation when Partial Prefetching is disabled', async () => {
    const one = `navigation-${randomUUID()}`
    await navigate(next, `/prefix/${one}/first`, 'first')
    for (const two of ['first', 'second']) {
      const result = await fetchSplitHTML(`/prefix/${one}/${two}`)
      expect(result.static$('#one').length).toBe(0)
      expect(result.static$('#two').length).toBe(0)
      expect(result.static$('#one-fallback').text()).toBe('loading one...')
      expect(result.dynamicPart).toContain(`<div id="one">${one}</div>`)
      expect(result.dynamicPart).toContain(`<div id="two">${two}</div>`)
    }
  })

  it('keeps a required fallback shared after a navigation when Partial Prefetching is disabled', async () => {
    const bottom = `navigation-${randomUUID()}`
    await navigate(next, `/mixed/short/${bottom}`, bottom)
    for (const value of [bottom, `${bottom}-other`]) {
      const result = await fetchSplitHTML(`/mixed/short/${value}`)
      expect(result.static$('#top').text()).toBe('short')
      expect(result.static$('#bottom').length).toBe(0)
      expect(result.static$('#bottom-fallback').text()).toBe(
        'loading bottom...'
      )
      expect(result.dynamicPart).toContain(`<div id="bottom">${value}</div>`)
      expect(result.static$('#dynamic').length).toBe(0)
    }
  })

  it('should not upgrade the fallback shell to a route shell', async () => {
    const pathname = '/two'
    const start = Date.now()

    await retry(
      async () => {
        const $ = await next.render$(pathname)
        expect($('#fallback').text()).toBe('loading...')
        expect($('#slug').closest('[hidden]').length).toBe(1)

        if (Date.now() - start < 5000) {
          throw new Error('continue polling fallback shell')
        }
      },
      6000,
      500,
      'fallback shell should remain unupgraded without partialPrefetching'
    )
  })

  it('should not specialize a generic shell into a more specific shell', async () => {
    const firstResult = await fetchSplitHTML('/prefix/c/foo')

    expect(firstResult.response.status).toBe(200)
    expect(firstResult.static$('#one').length).toBe(0)
    expect(firstResult.static$('#one-fallback').text()).toBe('loading one...')
    expect(firstResult.dynamicPart).toContain('<div id="one">c</div>')
    expect(firstResult.dynamicPart).toContain('<div id="two">foo</div>')

    const start = Date.now()

    await retry(
      async () => {
        const secondResult = await fetchSplitHTML('/prefix/c/bar')

        expect(secondResult.response.status).toBe(200)
        // The generic shell stays shared: `#one` is never baked into the
        // static part the way it is when Partial Prefetching is enabled.
        expect(secondResult.static$('#one').length).toBe(0)
        expect(secondResult.static$('#one-fallback').text()).toBe(
          'loading one...'
        )
        expect(secondResult.dynamicPart).toContain('<div id="one">c</div>')
        expect(secondResult.dynamicPart).toContain('<div id="two">bar</div>')

        if (Date.now() - start < 5000) {
          throw new Error('continue polling generic shell')
        }
      },
      6000,
      500,
      'generic shell should remain shared without partialPrefetching'
    )
  })

  it('shares an on-demand shell across params without generateStaticParams', async () => {
    const firstResult = await fetchSplitHTML('/blocking/c/foo')
    const renderedAt = firstResult.static$('#one').attr('data-rendered-at')

    expect(firstResult.static$('#one').text()).toBe('c')
    expect(renderedAt).toMatch(/^\d+(?:\.\d+)?$/)
    expect(firstResult.static$('#two').length).toBe(0)
    expect(firstResult.static$('#two-fallback').text()).toBe('loading two...')
    expect(firstResult.dynamicPart).toContain('<div id="two">foo</div>')

    if (isNextDeploy) {
      await retry(async () => {
        const cachedResult = await fetchSplitHTML('/blocking/c/foo')
        expect(cachedResult.response.headers.get('x-vercel-cache')).toBe('HIT')
      })
    }

    const secondResult = await fetchSplitHTML('/blocking/c/bar')

    expect(secondResult.static$('#one').text()).toBe('c')
    expect(secondResult.static$('#one').attr('data-rendered-at')).toBe(
      renderedAt
    )
    expect(secondResult.static$('#two').length).toBe(0)
    expect(secondResult.static$('#two-fallback').text()).toBe('loading two...')
    expect(secondResult.dynamicPart).toContain('<div id="two">bar</div>')
    expect(secondResult.dynamicPart).not.toContain('<div id="two">foo</div>')

    if (isNextDeploy) {
      expect(secondResult.response.headers.get('x-vercel-cache')).toBe('HIT')
    }
  })

  it('keeps params without generateStaticParams dynamic after explicit revalidation of an on-demand shell', async () => {
    const pathname = '/blocking/d/foo'
    const firstResult = await fetchSplitHTML(pathname)
    const firstRenderedAt = firstResult.static$('#one').attr('data-rendered-at')
    expect(firstRenderedAt).toMatch(/^\d+(?:\.\d+)?$/)

    if (isNextDeploy) {
      await retry(async () => {
        const cachedResult = await fetchSplitHTML(pathname)
        expect(cachedResult.response.headers.get('x-vercel-cache')).toBe('HIT')
        expect(cachedResult.static$('#one').attr('data-rendered-at')).toBe(
          firstRenderedAt
        )
      })
    }

    const revalidateResponse = await next.fetch(
      `/api/revalidate?path=${encodeURIComponent(pathname)}`
    )
    expect(revalidateResponse.status).toBe(200)
    expect(await revalidateResponse.json()).toEqual({ revalidated: true })

    await retry(async () => {
      const revalidatedResult = await fetchSplitHTML(pathname)
      const revalidatedAt = revalidatedResult
        .static$('#one')
        .attr('data-rendered-at')

      expect(revalidatedResult.static$('#one').text()).toBe('d')
      expect(revalidatedAt).toMatch(/^\d+(?:\.\d+)?$/)
      expect(revalidatedAt).not.toBe(firstRenderedAt)
      expect(revalidatedResult.static$('#two').length).toBe(0)
      expect(revalidatedResult.static$('#two-fallback').text()).toBe(
        'loading two...'
      )
      expect(revalidatedResult.dynamicPart).toContain('<div id="two">foo</div>')

      const secondResult = await fetchSplitHTML('/blocking/d/bar')

      expect(secondResult.static$('#one').text()).toBe('d')
      expect(secondResult.static$('#one').attr('data-rendered-at')).toBe(
        revalidatedAt
      )
      expect(secondResult.static$('#two').length).toBe(0)
      expect(secondResult.static$('#two-fallback').text()).toBe(
        'loading two...'
      )
      expect(secondResult.dynamicPart).toContain('<div id="two">bar</div>')
      expect(secondResult.dynamicPart).not.toContain('<div id="two">foo</div>')

      if (isNextDeploy) {
        expect(secondResult.response.headers.get('x-vercel-cache')).toBe('HIT')
      }
    })
  })

  it('keeps params without generateStaticParams dynamic after explicit revalidation of a servable fallback shell', async () => {
    const pathname = '/prefix/d/foo'
    const firstResult = await fetchSplitHTML(pathname)

    expect(firstResult.static$('#one').length).toBe(0)
    expect(firstResult.static$('#one-fallback').text()).toBe('loading one...')
    expect(firstResult.static$('#two').length).toBe(0)
    expect(firstResult.dynamicPart).toContain('<div id="one">d</div>')
    expect(firstResult.dynamicPart).toContain('<div id="two">foo</div>')

    const revalidateResponse = await next.fetch(
      `/api/revalidate?path=${encodeURIComponent(pathname)}`
    )
    expect(revalidateResponse.status).toBe(200)
    expect(await revalidateResponse.json()).toEqual({ revalidated: true })

    const revalidatedResult = await fetchSplitHTML(pathname)

    expect(revalidatedResult.static$('#two').length).toBe(0)
    expect(revalidatedResult.dynamicPart).toContain('<div id="two">foo</div>')

    const secondResult = await fetchSplitHTML('/prefix/d/bar')

    expect(secondResult.static$('#two').length).toBe(0)
    expect(secondResult.dynamicPart).toContain('<div id="two">bar</div>')
    expect(secondResult.dynamicPart).not.toContain('<div id="two">foo</div>')
  })

  it('reuses generated optional catch-all pages before and after explicit revalidation', async () => {
    for (const [pathname, parts] of [
      ['/optional/named', 'named'],
      ['/optional', ''],
    ]) {
      const first$ = await next.render$(pathname)
      const firstRenderedAt = first$('#optional').attr('data-rendered-at')

      expect(first$('#optional').text()).toBe(parts)
      expect(firstRenderedAt).toMatch(/^\d+(?:\.\d+)?$/)

      const repeated$ = await next.render$(pathname)

      expect(repeated$('#optional').text()).toBe(parts)
      expect({
        pathname,
        renderedAt: repeated$('#optional').attr('data-rendered-at'),
      }).toEqual({ pathname, renderedAt: firstRenderedAt })

      if (isNextDeploy) {
        await retry(async () => {
          const cachedResponse = await next.fetch(pathname)
          expect(cachedResponse.status).toBe(200)
          const cached$ = cheerio.load(await cachedResponse.text())
          expect(cachedResponse.headers.get('x-vercel-cache')).toBe('HIT')
          expect(cached$('#optional').attr('data-rendered-at')).toBe(
            firstRenderedAt
          )
        })
      }

      const revalidateResponse = await next.fetch(
        `/api/revalidate?path=${encodeURIComponent(pathname)}`
      )
      expect(revalidateResponse.status).toBe(200)
      expect(await revalidateResponse.json()).toEqual({ revalidated: true })

      await retry(async () => {
        const revalidated$ = await next.render$(pathname)
        const revalidatedRenderedAt =
          revalidated$('#optional').attr('data-rendered-at')

        expect(revalidated$('#optional').text()).toBe(parts)
        expect(revalidatedRenderedAt).toMatch(/^\d+(?:\.\d+)?$/)
        expect(revalidatedRenderedAt).not.toBe(firstRenderedAt)

        const cached$ = await next.render$(pathname)

        expect(cached$('#optional').text()).toBe(parts)
        expect({
          pathname,
          renderedAt: cached$('#optional').attr('data-rendered-at'),
        }).toEqual({ pathname, renderedAt: revalidatedRenderedAt })
      })
    }
  })

  it('revalidates the shared terminal shell without resolving dynamic params', async () => {
    const pathname = '/prefix/b/foo'
    const firstResult = await fetchSplitHTML(pathname)
    const firstRenderedAt = firstResult
      .static$('[data-rendered-at]')
      .attr('data-rendered-at')

    expect(firstResult.static$('[data-rendered-at]').length).toBe(1)
    expect(firstRenderedAt).toMatch(/^\d+(?:\.\d+)?$/)
    expect(firstResult.static$('#two').length).toBe(0)
    expect(firstResult.dynamicPart).toContain('<div id="two">foo</div>')

    const repeatedResult = await fetchSplitHTML(pathname)

    expect(repeatedResult.static$('[data-rendered-at]').length).toBe(1)
    expect(
      repeatedResult.static$('[data-rendered-at]').attr('data-rendered-at')
    ).toBe(firstRenderedAt)
    expect(repeatedResult.static$('#two').length).toBe(0)
    expect(repeatedResult.dynamicPart).toContain('<div id="two">foo</div>')

    const revalidateResponse = await next.fetch(
      `/api/revalidate?path=${encodeURIComponent(pathname)}`
    )
    expect(revalidateResponse.status).toBe(200)
    expect(await revalidateResponse.json()).toEqual({ revalidated: true })

    await retry(async () => {
      const revalidatedResult = await fetchSplitHTML(pathname)
      const revalidatedRenderedAt = revalidatedResult
        .static$('[data-rendered-at]')
        .attr('data-rendered-at')

      expect(revalidatedResult.static$('[data-rendered-at]').length).toBe(1)
      expect(revalidatedRenderedAt).toMatch(/^\d+(?:\.\d+)?$/)
      expect(revalidatedRenderedAt).not.toBe(firstRenderedAt)
      expect(revalidatedResult.static$('#two').length).toBe(0)
      expect(revalidatedResult.dynamicPart).toContain('<div id="two">foo</div>')

      const siblingResult = await fetchSplitHTML('/prefix/b/bar')

      expect(siblingResult.static$('[data-rendered-at]').length).toBe(1)
      expect(
        siblingResult.static$('[data-rendered-at]').attr('data-rendered-at')
      ).toBe(revalidatedRenderedAt)
      expect(siblingResult.static$('#two').length).toBe(0)
      expect(siblingResult.dynamicPart).toContain('<div id="two">bar</div>')
      expect(siblingResult.dynamicPart).not.toContain('<div id="two">foo</div>')
    })
  })
})

// The custom ISR handler exercises the non-minimal next start cache path.
// @force-gate start
describe('static fallback navigations with a custom cache handler', () => {
  describe.each([
    ['enabled', 'default'],
    ['disabled', 'partial-prefetching-disabled'],
  ])('with Partial Prefetching %s', (_name, fixture) => {
    const { next } = nextTestSetup({
      files: path.join(__dirname, 'fixtures', fixture),
      env: { FALLBACK_SHELL_CUSTOM_CACHE: '1' },
    })

    it('renders concrete params without marking a static fallback RSC payload as prerendered', async () => {
      const slug = `custom-handler-${randomUUID()}`
      const response = await next.fetch(`/client-params/${slug}`, {
        headers: { rsc: '1' },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/x-component')
      expect(await response.text()).not.toContain('%%drp:')
      expect(response.headers.get('x-nextjs-prerender')).toBeNull()
      await expectClientParamsNavigation(next)
    })

    it('renders concrete dynamic tail params from a generated shared shell instead of its placeholder RSC payload', async () => {
      const one = `custom-shell-${randomUUID()}`
      const initial = await next.fetch(`/client-tail-params/${one}/first`, {
        headers: { rsc: '1' },
      })
      expect(initial.status).toBe(200)
      expect(await initial.text()).not.toContain('%%drp:')
      expect(initial.headers.get('x-nextjs-prerender')).toBeNull()

      const key = getRouteCacheKey(`/client-tail-params/${one}/[two]`, {
        kind: RouteKind.APP_PAGE,
        sourceRoute: '/client-tail-params/[one]/[two]/page',
      })
      // Observe the cache write without a document request that could generate
      // it.
      await retry(() => {
        expect(next.cliOutput).toContain(`cache-handler:set ${key}`)
      })

      const repeated = await next.fetch(`/client-tail-params/${one}/second`, {
        headers: { rsc: '1' },
      })
      expect(repeated.status).toBe(200)
      const body = await repeated.text()
      expect(body).not.toContain('%%drp:')
      expect(body).toContain('"k":"second"')
      expect(repeated.headers.get('x-nextjs-prerender')).toBeNull()
    })
  })
})
