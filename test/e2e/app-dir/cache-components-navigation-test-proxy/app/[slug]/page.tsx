import { Suspense } from 'react'
import { connection } from 'next/server'

export function generateStaticParams() {
  return [{ slug: 'built' }]
}

async function Value({ slug }: { slug: string }) {
  'use cache'
  if (slug === 'built') {
    return <p id="value">Build-time value</p>
  }
  const response = await fetch(`https://navigation.test/cached?slug=${slug}`)
  return <p id="value">{await response.text()}</p>
}

async function Dynamic({ slug }: { slug: string }) {
  await connection()
  const response = await fetch(`https://navigation.test/dynamic?slug=${slug}`)
  return <p id="dynamic">{await response.text()}</p>
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  return (
    <>
      <Value slug={slug} />
      <Suspense fallback="Loading dynamic content">
        <Dynamic slug={slug} />
      </Suspense>
    </>
  )
}
