import { LinkAccordion } from '../../components/link-accordion'

export default function Page() {
  return (
    <>
      <LinkAccordion href="/acme/dashboard">
        Team project: acme/dashboard
      </LinkAccordion>
      <LinkAccordion href="/globex/portal">
        Team project: globex/portal
      </LinkAccordion>
    </>
  )
}
