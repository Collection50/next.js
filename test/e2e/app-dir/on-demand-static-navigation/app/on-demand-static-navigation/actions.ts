'use server'

import { updateTag } from 'next/cache'

export async function updateValue(kind: string, slug: string) {
  updateTag(`on-demand-static-navigation:${kind}:${slug}`)
}
