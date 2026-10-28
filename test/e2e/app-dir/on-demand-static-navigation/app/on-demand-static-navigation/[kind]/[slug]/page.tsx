import { Suspense } from 'react'
import { randomUUID } from 'node:crypto'
import { connection } from 'next/server'
import { getValue } from '../../../../lib/value'
import { updateValue } from '../../actions'

export function generateStaticParams() {
  return [
    { kind: 'static', slug: 'built' },
    { kind: 'partial', slug: 'built' },
  ]
}

async function Value({ kind, slug }: { kind: string; slug: string }) {
  return <p id="value">{await getValue(kind, slug)}</p>
}

async function Dynamic({ slug }: { slug: string }) {
  await connection()
  if (process.env.TEST_DATA_SERVICE_URL) {
    await fetch(`${process.env.TEST_DATA_SERVICE_URL}/?key=dynamic:${slug}`)
  }
  return <p id="dynamic">{randomUUID()}</p>
}

export default async function Page({
  params,
}: {
  params: Promise<{ kind: string; slug: string }>
}) {
  const { kind, slug } = await params
  return (
    <>
      <h1>{kind} page</h1>
      <Value kind={kind} slug={slug} />
      <form action={updateValue.bind(null, kind, slug)}>
        <button id="update">Update value</button>
      </form>
      {kind === 'partial' ? (
        <Suspense fallback={<p>Loading dynamic content</p>}>
          <Dynamic slug={slug} />
        </Suspense>
      ) : null}
    </>
  )
}
