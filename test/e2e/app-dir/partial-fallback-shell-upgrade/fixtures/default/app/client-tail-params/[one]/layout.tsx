import { Suspense, type ReactNode } from 'react'

export function generateStaticParams() {
  return [{ one: 'built' }]
}

async function Content({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ one: string }>
}) {
  const { one } = await params
  return <section data-one={one}>{children}</section>
}

export default function Layout(props: {
  children: ReactNode
  params: Promise<{ one: string }>
}) {
  return (
    <Suspense fallback={<p>Loading first param...</p>}>
      <Content {...props} />
    </Suspense>
  )
}
