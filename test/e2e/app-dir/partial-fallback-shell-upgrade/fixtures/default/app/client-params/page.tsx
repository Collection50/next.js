import Link from 'next/link'

export default function Page() {
  return (
    <>
      <h1>Client params navigation hub</h1>
      {['first', 'second'].map((slug) => (
        <Link
          key={slug}
          id={`client-link-${slug}`}
          href={`/client-params/${slug}`}
          prefetch={false}
        >
          {slug}
        </Link>
      ))}
    </>
  )
}
