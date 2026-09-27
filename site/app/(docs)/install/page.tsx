import type { Metadata } from "next"
import { Code } from "@/components/code"
import { InlineCode } from "@/components/inline-code"
import { PageHeader } from "@/components/docs/page-header"
import { Section } from "@/components/docs/section"

export const metadata: Metadata = {
  title: "Install — pre-post",
  description: "Install pre-post once, then type /pre-post after any UI change.",
  alternates: { canonical: "/install" },
}

export default function InstallPage() {
  return (
    <>
      <PageHeader title="Install">Run this once in your terminal:</PageHeader>

      <div className="space-y-3 text-[15px]">
        <Code>npx skills add juangadm/pre-post -y</Code>
        <p>
          Then type <InlineCode>/pre-post</InlineCode> after any UI change.
        </p>
      </div>

      <Section id="action" title="On every PR, automatically">
        <p>
          Add the{" "}
          <a
            href="https://github.com/juangadm/pre-post/blob/main/docs/github-action.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-800 underline underline-offset-2 hover:text-neutral-600"
          >
            GitHub Action
          </a>
          . Nobody has to remember to run it.
        </p>
      </Section>

      <Section id="requirements" title="You'll need">
        <p>
          Node 20+, GitHub sign-in (<InlineCode>gh auth login</InlineCode>), and an open PR.
        </p>
        <p>
          Stuck? Run <InlineCode>pre-post doctor</InlineCode>.
        </p>
      </Section>
    </>
  )
}
