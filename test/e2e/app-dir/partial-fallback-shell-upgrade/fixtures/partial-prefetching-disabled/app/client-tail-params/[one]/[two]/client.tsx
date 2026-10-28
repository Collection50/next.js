'use client'

import { useParams } from 'next/navigation'

export default function ClientParams() {
  const params = useParams<{ one: string; two: string }>()
  return <p id="client-tail-param">{params?.two}</p>
}
