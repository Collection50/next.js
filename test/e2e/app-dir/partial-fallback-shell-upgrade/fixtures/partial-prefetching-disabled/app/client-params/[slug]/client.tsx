'use client'

import { useParams } from 'next/navigation'

export default function ClientParams() {
  const params = useParams<{ slug: string }>()
  return <p id="client-param">{params?.slug}</p>
}
