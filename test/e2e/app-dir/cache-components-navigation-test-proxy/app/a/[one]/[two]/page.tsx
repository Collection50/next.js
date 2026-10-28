export default async function Page({
  params,
}: {
  params: Promise<{ one: string; two: string }>
}) {
  const { one, two } = await params
  return (
    <>
      <p id="one-value">{`one:${one}`}</p>
      <p id="two-value">{`two:${two}`}</p>
    </>
  )
}
