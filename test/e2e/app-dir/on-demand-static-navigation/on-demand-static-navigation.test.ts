import { nextTestSetup } from 'e2e-utils'
import { findPort, retry } from 'next-test-utils'
import type * as Playwright from 'playwright'
import { createRouterAct } from 'router-act'
import { randomUUID } from 'node:crypto'
import { load } from 'cheerio'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getRouteCacheKey } from 'next/dist/server/lib/route-cache-key'
import { RouteKind } from 'next/dist/server/route-kind'
import { createTestDataServer } from 'test-data-service/writer'

// @force-gate prod
describe('on-demand static navigation', () => {
  describe('with default memory cache', () => {
    runTests()
  })

  // The memory cache setting only affects the self-hosted ISR cache.
  // @force-gate start
  describe('with disabled memory cache', () => {
    runTests('0')
  })

  function runTests(memorySize?: string) {
    const { next, isNextStart, isNextDeploy } = nextTestSetup({
      files: __dirname,
      skipStart: true,
      env: {
        ...(memorySize !== undefined && {
          ISR_CACHE_MEMORY_SIZE: memorySize,
        }),
      },
    })

    let dataServer: ReturnType<typeof createTestDataServer>
    const heldResponses = new Map<string, Array<() => void>>()
    const receivedRequests = new Map<string, number>()
    const failedRequests = new Set<string>()
    const dynamicEntryChecks = new Map<string, Promise<unknown>>()

    beforeAll(async () => {
      if (isNextStart) {
        dataServer = createTestDataServer((key, response) => {
          receivedRequests.set(key, (receivedRequests.get(key) ?? 0) + 1)
          if (failedRequests.has(key)) {
            response.reject(new Error(`Failed test data: ${key}`))
            return
          }
          if (key.startsWith('dynamic:cold-partial-')) {
            const slug = key.slice('dynamic:'.length)
            dynamicEntryChecks.set(
              slug,
              fs
                .readFile(metadataPath('partial', slug), 'utf8')
                .then((text) => typeof JSON.parse(text).postponed === 'string')
                .catch((error) => error)
            )
          }
          const resolve = () => response.resolve(`${key}:${randomUUID()}`)
          const held = heldResponses.get(key)
          if (held) {
            held.push(resolve)
          } else {
            resolve()
          }
        })
        const port = await findPort()
        dataServer.listen(port)
        next.env.TEST_DATA_SERVICE_URL = `http://localhost:${port}`
      }
      await next.start()
    })

    afterAll(() => dataServer?.close())

    function holdData(kind: string, slug: string) {
      const key = `${kind}:${slug}`
      heldResponses.set(key, [])
      return {
        async requested() {
          await retry(() => expect(receivedRequests.has(key)).toBe(true))
        },
        release() {
          const held = heldResponses.get(key)
          heldResponses.delete(key)
          held?.forEach((resolve) => resolve())
        },
      }
    }

    function metadataPath(kind: string, slug: string) {
      const key = getRouteCacheKey(pathname(kind, slug), {
        kind: RouteKind.APP_PAGE,
        sourceRoute: '/on-demand-static-navigation/[kind]/[slug]/page',
      })
      return join(next.testDir, '.next/server', `${key}.meta`)
    }

    async function storedValue(kind: string, slug: string) {
      const htmlPath = metadataPath(kind, slug).replace(/\.meta$/, '.html')
      const $ = load(await fs.readFile(htmlPath, 'utf8'))
      return $('#value').text()
    }

    function pathname(kind: string, slug: string) {
      return `/on-demand-static-navigation/${kind}/${slug}`
    }

    async function read(kind: string, slug: string) {
      const response = await next.fetch(pathname(kind, slug))
      expect(response.status).toBe(200)
      const $ = load(await response.text())
      return {
        value: $('#value').text(),
        dynamic: $('#dynamic').text(),
        cache: response.headers.get(
          isNextDeploy ? 'x-vercel-cache' : 'x-nextjs-cache'
        ),
      }
    }

    async function warm(slug: string, kind = 'static') {
      return retry(async () => {
        const result = await read(kind, slug)
        expect(result.value).toStartWith(`${kind}:${slug}:`)
        if (kind === 'static') {
          expect(isNextDeploy ? ['HIT', 'PRERENDER'] : ['HIT']).toContain(
            result.cache
          )
        }
        return result.value
      })
    }

    async function navigate(kind: string, slug: string, value?: string) {
      let act: ReturnType<typeof createRouterAct>
      const responses: Array<{ status: number; cache: string | undefined }> = []
      const target = pathname(kind, slug)
      const browser = await next.browser(
        `/on-demand-static-navigation/hub?kind=${kind}&slug=${slug}`,
        {
          beforePageLoad(page: Playwright.Page) {
            act = createRouterAct(page)
            page.on('response', (response) => {
              const request = response.request()
              const headers = request.headers()
              if (
                new URL(request.url()).pathname === target &&
                headers.rsc &&
                headers['next-router-prefetch'] === undefined &&
                headers['next-action'] === undefined
              ) {
                responses.push({
                  status: response.status(),
                  cache:
                    response.headers()[
                      isNextDeploy ? 'x-vercel-cache' : 'x-nextjs-cache'
                    ],
                })
              }
            })
          },
        }
      )
      try {
        await act(() => browser.elementById('target').click(), {
          includes: value ?? `${kind}:${slug}:`,
        })
        const renderedValue = await browser.elementById('value').text()
        if (value !== undefined) {
          expect(renderedValue).toBe(value)
        }
        expect(responses.length).toBeGreaterThan(0)
        return { browser, responses, value: renderedValue }
      } catch (error) {
        await browser.close()
        throw error
      }
    }

    async function expectStaticNavigation(slug: string, value?: string) {
      const navigation = await navigate('static', slug, value)
      try {
        for (const response of navigation.responses) {
          expect(response.status).toBe(200)
          expect(isNextDeploy ? ['HIT', 'PRERENDER'] : ['HIT']).toContain(
            response.cache
          )
        }
        return navigation.value
      } finally {
        await navigation.browser.close()
      }
    }

    it('serves stored RSC when navigating to a fully static build-time prerender', async () => {
      await expectStaticNavigation('built', await warm('built'))
    })

    it('serves stored RSC on navigation after a document request generates a fully static prerender', async () => {
      const slug = `runtime-${randomUUID()}`
      const value = await warm(slug)
      expect((await read('static', slug)).value).toBe(value)
      await expectStaticNavigation(slug, value)
    })

    it('uses cached values and fresh request-time content when navigating to a partially static build-time prerender', async () => {
      const rendered = await read('partial', 'built')
      expect(rendered.value).toStartWith('partial:built:')
      expect(rendered.dynamic).not.toBe('')
      const { browser } = await navigate('partial', 'built', rendered.value)
      try {
        expect(await browser.elementById('dynamic').text()).not.toBe(
          rendered.dynamic
        )
      } finally {
        await browser.close()
      }
    })

    it('executes a Server Action on a cached fully static page and renders its updated value', async () => {
      const slug = `action-${randomUUID()}`
      const value = await warm(slug)
      let act: ReturnType<typeof createRouterAct>
      const browser = await next.browser(pathname('static', slug), {
        beforePageLoad(page: Playwright.Page) {
          act = createRouterAct(page)
        },
      })
      try {
        expect(await browser.elementById('value').text()).toBe(value)
        await act(() => browser.elementById('update').click())
        expect(await browser.elementById('value').text()).not.toBe(value)
      } finally {
        await browser.close()
      }
    })

    // These tests inspect and age entries in the self-hosted ISR cache.
    // @force-gate start
    describe('self-hosted ISR', () => {
      function statusPathname(kind: string, slug: string) {
        return `/on-demand-static-navigation/http-status/${kind}/${slug}`
      }

      function statusMetadataPath(kind: string, slug: string) {
        const key = getRouteCacheKey(statusPathname(kind, slug), {
          kind: RouteKind.APP_PAGE,
          sourceRoute:
            '/on-demand-static-navigation/http-status/[kind]/[slug]/page',
        })
        return join(next.testDir, '.next/server', `${key}.meta`)
      }

      async function readStatus(kind: string, slug: string, rsc = true) {
        const response = await next.fetch(
          `${statusPathname(kind, slug)}${rsc ? '?_rsc' : ''}`,
          {
            headers: rsc ? { rsc: '1' } : undefined,
            redirect: 'manual',
          }
        )
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: await response.text(),
        }
      }

      for (const [kind, status] of [
        ['not-found', 404],
        ['partial-not-found', 404],
        ['forbidden', 403],
        ['unauthorized', 401],
        ['redirect', 307],
        ['partial-redirect', 307],
      ] as const) {
        it(`returns 200 for cold and cached ${kind} RSC requests and ${status} for documents`, async () => {
          const slug = `status-${randomUUID()}`
          for (let request = 0; request < 2; request++) {
            const response = await readStatus(kind, slug)
            expect(response.status).toBe(200)
            expect(response.contentType).toContain('text/x-component')
            expect(response.body).toContain(
              status === 307
                ? 'NEXT_REDIRECT'
                : `NEXT_HTTP_ERROR_FALLBACK;${status}`
            )
          }
          const metadata = JSON.parse(
            await fs.readFile(statusMetadataPath(kind, slug), 'utf8')
          )
          expect(metadata.status).toBe(status)
          if (kind.startsWith('partial-')) {
            expect(typeof metadata.postponed).toBe('string')
          } else {
            expect(metadata.postponed).toBeUndefined()
          }
          expect((await readStatus(kind, slug, false)).status).toBe(status)
        })
      }

      it('keeps a cold not-found RSC navigation in the client router without a document reload', async () => {
        const slug = `browser-status-${randomUUID()}`
        const target = statusPathname('partial-not-found', slug)
        const documents: string[] = []
        const statuses: number[] = []
        let act: ReturnType<typeof createRouterAct>
        const browser = await next.browser(
          `/on-demand-static-navigation/hub?kind=http-status/partial-not-found&slug=${slug}`,
          {
            beforePageLoad(page: Playwright.Page) {
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
                  statuses.push(response.status())
                }
              })
            },
          }
        )
        try {
          await act(() => browser.elementById('target').click(), {
            includes: 'Navigation not found',
          })
          expect(
            await browser.elementById('http-status-not-found').text()
          ).toBe('Navigation not found')
          expect(statuses.length).toBeGreaterThan(0)
          expect(statuses.every((status) => status === 200)).toBe(true)
          expect(documents).toEqual(['/on-demand-static-navigation/hub'])
        } finally {
          await browser.close()
        }
      })

      it('preserves the status set by the proxy before a not-found RSC prerender', async () => {
        const slug = `preserve-status-${randomUUID()}`
        expect((await readStatus('not-found', slug)).status).toBe(202)
        expect((await readStatus('not-found', slug)).status).toBe(202)
        expect((await readStatus('not-found', slug, false)).status).toBe(404)
      })

      for (const kind of ['not-found', 'partial-redirect']) {
        it(`returns 200 after an expired ${kind} RSC navigation blocks on regeneration`, async () => {
          const slug = `expired-status-${randomUUID()}`
          const expectedStatus = kind === 'not-found' ? 404 : 307
          expect((await readStatus(kind, slug, false)).status).toBe(
            expectedStatus
          )
          await next.stop()
          const metaPath = statusMetadataPath(kind, slug)
          const metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'))
          metadata.routeCacheLastModified = Math.floor(
            performance.timeOrigin + performance.now() - (86400 + 60) * 1000
          )
          await fs.writeFile(metaPath, JSON.stringify(metadata))
          await next.start({ skipBuild: true })
          const data = holdData(`http-status:${kind}`, slug)
          let completed = false
          const pending = readStatus(kind, slug).then((response) => {
            completed = true
            return response
          })
          try {
            await data.requested()
            expect(completed).toBe(false)
          } finally {
            data.release()
          }
          expect((await pending).status).toBe(200)
          expect((await readStatus(kind, slug, false)).status).toBe(
            expectedStatus
          )
        })
      }

      it('returns 200 to both concurrent RSC requests sharing a cold not-found prerender', async () => {
        const kind = 'not-found'
        const slug = `concurrent-status-${randomUUID()}`
        const data = holdData(`http-status:${kind}`, slug)
        const first = readStatus(kind, slug)
        let second: Promise<Awaited<ReturnType<typeof readStatus>>> | undefined
        try {
          await data.requested()
          second = readStatus(kind, slug)
          await retry(() => {
            expect(
              receivedRequests.get(`request:${kind}:${slug}`) ?? 0
            ).toBeGreaterThanOrEqual(2)
          })
        } finally {
          data.release()
          await Promise.allSettled([first, second])
        }
        const responses = await Promise.all([first, second!])
        expect(responses.map((response) => response.status)).toEqual([200, 200])
        for (const response of responses) {
          expect(response.body).toContain('NEXT_HTTP_ERROR_FALLBACK;404')
        }
        expect((await readStatus(kind, slug, false)).status).toBe(404)
      })

      for (const kind of ['static', 'partial']) {
        const page =
          kind === 'static' ? 'fully static page' : 'partially static page'

        async function agePrerender(age: number) {
          const slug = `aged-${randomUUID()}`
          const value = await warm(slug, kind)
          await next.stop()
          const metaPath = metadataPath(kind, slug)
          const metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'))
          const agedTimestamp = Math.floor(
            performance.timeOrigin + performance.now() - age * 1000
          )
          metadata.routeCacheLastModified = agedTimestamp
          await fs.writeFile(metaPath, JSON.stringify(metadata))
          await next.start({ skipBuild: true })
          return { slug, value, metaPath, agedTimestamp }
        }

        it(`shares cached values between concurrent cold document and navigation requests to a ${page}`, async () => {
          const slug = `concurrent-${kind}-${randomUUID()}`
          let act: ReturnType<typeof createRouterAct>
          const browser = await next.browser(
            `/on-demand-static-navigation/hub?kind=${kind}&slug=${slug}`,
            {
              beforePageLoad(page: Playwright.Page) {
                act = createRouterAct(page)
              },
            }
          )
          const data = holdData(kind, slug)
          let documentCompleted = false
          let navigationCompleted = false
          const documentRequest = read(kind, slug).then((document) => {
            documentCompleted = true
            return document
          })
          let navigationRequest = Promise.resolve()
          try {
            await data.requested()
            navigationRequest = act(
              () => browser.elementById('target').click(),
              {
                includes: `${kind}:${slug}:`,
              }
            ).then(() => {
              navigationCompleted = true
            })
            // Both requests must reach the server while generation is held.
            await retry(() => {
              expect(
                receivedRequests.get(`request:${kind}:${slug}`) ?? 0
              ).toBeGreaterThanOrEqual(2)
            })
            expect(documentCompleted).toBe(false)
            expect(navigationCompleted).toBe(false)
            data.release()

            const [document] = await Promise.all([
              documentRequest,
              navigationRequest,
            ])
            expect(await browser.elementById('value').text()).toBe(
              document.value
            )
            expect(await storedValue(kind, slug)).toBe(document.value)
            if (kind === 'partial') {
              expect(await browser.elementById('dynamic').text()).not.toBe(
                document.dynamic
              )
            }
          } finally {
            data.release()
            await Promise.allSettled([documentRequest, navigationRequest])
            await browser.close()
          }
        })

        it(`retries a failed cold ${page} navigation without caching recovery output`, async () => {
          const slug = `failure-${kind}-${randomUUID()}`
          const key = `${kind}:${slug}`
          failedRequests.add(key)
          try {
            const response = await next.fetch(pathname(kind, slug), {
              headers: { rsc: '1' },
            })
            expect(response.status).toBe(500)
            await response.text()
            expect(response.headers.get('x-nextjs-cache')).toBeNull()
            await expect(
              fs.access(metadataPath(kind, slug))
            ).rejects.toMatchObject({
              code: 'ENOENT',
            })
          } finally {
            failedRequests.delete(key)
          }
          const navigation = await navigate(kind, slug)
          try {
            expect(await storedValue(kind, slug)).toBe(navigation.value)
            expect((await read(kind, slug)).value).toBe(navigation.value)
          } finally {
            await navigation.browser.close()
          }
        })

        it(`serves a stale ${page} during background regeneration`, async () => {
          const { slug, value, metaPath, agedTimestamp } = await agePrerender(
            3600 + 60
          )
          const data = holdData(kind, slug)
          try {
            const navigation = await navigate(kind, slug, value)
            await navigation.browser.close()
            await data.requested()
            const metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'))
            expect(metadata.routeCacheLastModified).toBe(agedTimestamp)
            expect(await storedValue(kind, slug)).toBe(value)
            for (const response of navigation.responses) {
              expect(response.status).toBe(200)
              expect(response.cache).toBe(
                kind === 'static' ? 'STALE' : undefined
              )
            }
          } finally {
            data.release()
          }

          await retry(async () => {
            const metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'))
            expect(metadata.routeCacheLastModified).toBeGreaterThan(
              agedTimestamp
            )
          })
          const regenerated = await storedValue(kind, slug)
          expect(regenerated).not.toBe(value)
          const navigation = await navigate(kind, slug, regenerated)
          await navigation.browser.close()
          expect((await read(kind, slug)).value).toBe(regenerated)
        })

        it(`blocks an expired ${page} navigation until regeneration completes`, async () => {
          const { slug, value, metaPath, agedTimestamp } = await agePrerender(
            86400 + 60
          )
          const data = holdData(kind, slug)
          let completed = false
          const pending = navigate(kind, slug).then((navigation) => {
            completed = true
            return navigation
          })
          try {
            await data.requested()
            expect(completed).toBe(false)
            expect(
              JSON.parse(await fs.readFile(metaPath, 'utf8'))
                .routeCacheLastModified
            ).toBe(agedTimestamp)
          } finally {
            data.release()
          }
          const navigation = await pending
          try {
            expect(navigation.value).not.toBe(value)
            expect(await storedValue(kind, slug)).toBe(navigation.value)
            expect(
              JSON.parse(await fs.readFile(metaPath, 'utf8'))
                .routeCacheLastModified
            ).toBeGreaterThan(agedTimestamp)
            for (const response of navigation.responses) {
              expect(response.cache).toBe(
                kind === 'static' ? 'REVALIDATED' : undefined
              )
            }
            expect((await read(kind, slug)).value).toBe(navigation.value)
          } finally {
            await navigation.browser.close()
          }
        })

        it(`blocks a cold ${page} navigation and reuses its prerender after a restart`, async () => {
          const slug = `cold-${kind}-${randomUUID()}`
          const data = holdData(kind, slug)
          let completed = false
          const pending = navigate(kind, slug).then((navigation) => {
            completed = true
            return navigation
          })
          try {
            await data.requested()
            expect(completed).toBe(false)
          } finally {
            data.release()
          }
          const initial = await pending
          const dynamic =
            kind === 'partial'
              ? await initial.browser.elementById('dynamic').text()
              : undefined
          await initial.browser.close()
          expect(await storedValue(kind, slug)).toBe(initial.value)
          if (kind === 'partial') {
            expect(dynamicEntryChecks.has(slug)).toBe(true)
            expect(await dynamicEntryChecks.get(slug)).toBe(true)
          } else {
            for (const response of initial.responses) {
              expect(response.cache).toBe('MISS')
            }
          }

          await next.stop()
          await next.start({ skipBuild: true })
          const repeated = await navigate(kind, slug, initial.value)
          try {
            if (kind === 'partial') {
              expect(
                await repeated.browser.elementById('dynamic').text()
              ).not.toBe(dynamic)
            } else {
              for (const response of repeated.responses) {
                expect(response.cache).toBe('HIT')
              }
            }
            expect((await read(kind, slug)).value).toBe(initial.value)
          } finally {
            await repeated.browser.close()
          }
        })
      }
    })
  }
})
