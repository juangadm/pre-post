import { AutoPlayHero } from "@/components/hero"
import { Code } from "@/components/code"
import { InlineCode } from "@/components/inline-code"
import { PageHeader } from "@/components/docs/page-header"
import { Section } from "@/components/docs/section"

export default function Page() {
  return (
    <>
      <PageHeader title="The fastest visual proof for your PRs.">
        Your coding agent captures every UI change in seconds, so you review faster and ship
        faster.
      </PageHeader>

      {/* Extra side padding on mobile for the hero's transformed elements */}
      <div className="px-4 sm:px-0">
        <AutoPlayHero />
      </div>

      <Section title="How you use it">
        <ol className="list-decimal pl-5 space-y-3 marker:text-neutral-400">
          <li className="space-y-2">
            <p>Install it once by running this in your terminal:</p>
            <Code>npx skills add juangadm/pre-post -y</Code>
          </li>
          <li>Ask your coding agent to change your UI as usual</li>
          <li>
            When it&apos;s done, type <InlineCode>/pre-post</InlineCode>
          </li>
          <li>
            Open your PR. The before and after visuals are ready for you to compare and
            reviewers to approve.
          </li>
        </ol>
      </Section>
    </>
  )
}
