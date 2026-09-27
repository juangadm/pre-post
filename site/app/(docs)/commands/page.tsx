import type { Metadata } from "next"
import { InlineCode } from "@/components/inline-code"
import { PageHeader } from "@/components/docs/page-header"
import { RefTable } from "@/components/docs/ref-table"
import { Section } from "@/components/docs/section"

export const metadata: Metadata = {
  title: "Commands — pre-post",
  description: "Every pre-post command and option, in one table.",
  alternates: { canonical: "/commands" },
}

export default function CommandsPage() {
  return (
    <>
      <PageHeader title="Commands">You&apos;ll mostly just need the first one.</PageHeader>

      <div className="space-y-3">
        <RefTable
          head={["Command", "What it does"]}
          rows={[
            ["pre-post pr", "Adds before and after visuals to your PR"],
            ["pre-post <url> <url>", "Compares any two sites"],
            ["pre-post login <url>", "Signs in once to a protected site"],
            ["pre-post doctor", "Checks your setup"],
            ["pre-post prune", "Deletes old visuals"],
          ]}
        />
        <p className="text-[14px] text-neutral-400">
          Your agent runs these for you. To run one yourself, start it with{" "}
          <InlineCode>npx -y @juangadm/pre-post@latest</InlineCode>.
        </p>
      </div>

      <Section id="options" title="Options">
        <RefTable
          head={["Add", "To"]}
          rows={[
            ["--routes /pricing", "Pick the pages yourself"],
            ["--mobile", "Add mobile"],
            ["--dry-run", "Try it without touching your PR"],
          ]}
        />
        <p className="text-[14px] text-neutral-400">
          Everything else is in the{" "}
          <a
            href="https://github.com/juangadm/pre-post/blob/main/docs/reference.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-600 underline underline-offset-2 hover:text-neutral-800"
          >
            full reference
          </a>
          .
        </p>
      </Section>
    </>
  )
}
