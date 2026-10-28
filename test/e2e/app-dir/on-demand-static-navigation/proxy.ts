import { NextRequest, NextResponse } from 'next/server'

export async function proxy(request: NextRequest) {
  const [kind, slug] = request.nextUrl.pathname.split('/').slice(-2)
  if (process.env.TEST_DATA_SERVICE_URL && slug.startsWith('concurrent-')) {
    await fetch(
      `${process.env.TEST_DATA_SERVICE_URL}/?key=request:${kind}:${slug}`
    )
  }
  if (slug.startsWith('preserve-status-')) {
    return NextResponse.next({ status: 202 })
  }
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/on-demand-static-navigation/:kind/:slug',
    '/on-demand-static-navigation/http-status/:kind/:slug',
  ],
}
