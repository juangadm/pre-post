import type { Metadata } from "next"
import { PageHeader } from "@/components/docs/page-header"
import { Section } from "@/components/docs/section"

export const metadata: Metadata = {
  title: "How it works — pre-post",
  description:
    "Detect, capture, share: pre-post finds the pages you changed, shows them before and after, and puts the visuals at the top of your PR.",
  alternates: { canonical: "/how-it-works" },
}

export default function HowItWorksPage() {
  return (
    <>
      <PageHeader title="How it works">Three steps, all automatic.</PageHeader>

      <Section id="detect" title="Detect">
        <p>It finds every page your change touched. You don&apos;t list anything.</p>
      </Section>

      <Section id="capture" title="Capture">
        <p>
          It shows each page before and after. A screenshot when something looks different, a
          short video when something moves.
        </p>
      </Section>

      <Section id="share" title="Share">
        <p>
          The visuals land at the top of your PR, ready to review. Run it again and they update.
        </p>
      </Section>
    </>
  )
}
