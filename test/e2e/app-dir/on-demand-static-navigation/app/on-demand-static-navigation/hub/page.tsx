import Link from 'next/link'
import { Suspense } from 'react'
import { connection } from 'next/server'

async function Content({
  searchParams,
}: Pick<PageProps<'/on-demand-static-navigation/hub'>, 'searchParams'>) {
  await connection()
  const { kind, slug } = await searchParams
  if (typeof kind !== 'string' || typeof slug !== 'string') {
    throw new Error('The navigation hub requires a kind and slug')
  }
  return (
    <>
      <h1>Navigation hub</h1>
      <Link
        id="target"
        href={`/on-demand-static-navigation/${kind}/${slug}`}
        prefetch={false}
      >
        Target
      </Link>
    </>
  )
}

export default function Page({
  searchParams,
}: PageProps<'/on-demand-static-navigation/hub'>) {
  return (
    <Suspense fallback={<p>Loading hub</p>}>
      <Content searchParams={searchParams} />
    </Suspense>
  )
}
