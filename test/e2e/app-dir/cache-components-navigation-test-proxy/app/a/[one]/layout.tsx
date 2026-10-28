import type { ReactNode } from 'react'

export function generateStaticParams() {
  return [{ one: 'built' }]
}

export default async function Layout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ one: string }>
}) {
  const { one } = await params
  return <section data-one={one}>{children}</section>
}
