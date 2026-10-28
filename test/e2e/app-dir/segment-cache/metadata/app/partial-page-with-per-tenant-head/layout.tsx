import { cookies } from 'next/headers'
import { Suspense, type ReactNode } from 'react'

async function RuntimeContent() {
  await cookies()
  return <p>Runtime layout content</p>
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <RuntimeContent />
      </Suspense>
      {children}
    </>
  )
}
