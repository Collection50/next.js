import { cacheLife, cacheTag } from 'next/cache'

export async function getValue(kind: string, slug: string) {
  'use cache'
  cacheLife('hours')
  cacheTag(`on-demand-static-navigation:${kind}:${slug}`)
  if (process.env.TEST_DATA_SERVICE_URL) {
    const response = await fetch(
      `${process.env.TEST_DATA_SERVICE_URL}/?key=${kind}:${slug}`
    )
    if (!response.ok) {
      throw new Error(`Failed to load ${kind}:${slug}`)
    }
    return response.text()
  }
  return `${kind}:${slug}:${new Date().toISOString()}`
}
