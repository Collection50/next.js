import { Suspense } from 'react'
import ClientParams from './client'

export function generateStaticParams() {
  return [{ slug: 'built' }]
}

export default function Page() {
  return (
    <Suspense fallback={<p>Loading client params...</p>}>
      <ClientParams />
    </Suspense>
  )
}
