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

      <figure className="pt-2 pb-2">
        {/* Extra side padding on mobile for the hero's transformed elements */}
        <div className="px-4 sm:px-0">
          <AutoPlayHero />
        </div>
      </figure>

      <Section title="How you use it">
        <ol className="space-y-4">
          <li className="flex gap-2">
            <span className="w-8 shrink-0 font-mono text-[#e63e26]">01</span>
            <div className="min-w-0 flex-1 space-y-2">
              <p>Install it once by running this in your terminal:</p>
              <Code>npx skills add juangadm/pre-post -y</Code>
            </div>
          </li>
          <li className="flex gap-2">
            <span className="w-8 shrink-0 font-mono text-[#e63e26]">02</span>
            <span>Ask your coding agent to change your UI as usual</span>
          </li>
          <li className="flex gap-2">
            <span className="w-8 shrink-0 font-mono text-[#e63e26]">03</span>
            <span>When it&apos;s done, type <InlineCode>/pre-post</InlineCode></span>
          </li>
          <li className="flex gap-2">
            <span className="w-8 shrink-0 font-mono text-[#e63e26]">04</span>
            <span>Open your PR. The before and after visuals are ready for you to compare and reviewers to approve.</span>
          </li>
        </ol>
      </Section>
    </>
  )
}
