import { Suspense } from 'react'
import { connection } from 'next/server'
import { forbidden, notFound, redirect, unauthorized } from 'next/navigation'
import { getValue } from '../../../../../lib/value'

export function generateStaticParams() {
  return [{ kind: 'ok', slug: 'built' }]
}

async function Outcome({ kind, slug }: { kind: string; slug: string }) {
  const value = await getValue(`http-status:${kind}`, slug)
  if (kind.endsWith('not-found')) {
    notFound()
  }
  if (kind === 'forbidden') {
    forbidden()
  }
  if (kind === 'unauthorized') {
    unauthorized()
  }
  if (kind.endsWith('redirect')) {
    redirect('/on-demand-static-navigation/static/built')
  }
  return <p>{value}</p>
}

async function Dynamic() {
  await connection()
  return <p>Request-time content</p>
}

export default async function Page({
  params,
}: PageProps<'/on-demand-static-navigation/http-status/[kind]/[slug]'>) {
  const { kind, slug } = await params
  const outcome = <Outcome kind={kind} slug={slug} />
  return kind.startsWith('partial-') ? (
    <>
      <Suspense fallback={<p>Loading outcome</p>}>{outcome}</Suspense>
      <Suspense fallback={<p>Loading request-time content</p>}>
        <Dynamic />
      </Suspense>
    </>
  ) : (
    outcome
  )
}
