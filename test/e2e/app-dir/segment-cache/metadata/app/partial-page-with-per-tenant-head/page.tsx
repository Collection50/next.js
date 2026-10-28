import { LinkAccordion } from '../link-accordion'

export default function Page() {
  return (
    <>
      <LinkAccordion href="/partial-page-with-per-tenant-head/en/acme">
        Partially static page with per-tenant head (en/acme)
      </LinkAccordion>
      <LinkAccordion
        prefetch={false}
        href="/partial-page-with-per-tenant-head/en/initech"
      >
        Partially static page with per-tenant head (en/initech)
      </LinkAccordion>
    </>
  )
}
