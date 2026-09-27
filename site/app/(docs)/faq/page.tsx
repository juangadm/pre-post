import type { Metadata } from "next"
import { PageHeader } from "@/components/docs/page-header"

export const metadata: Metadata = {
  title: "FAQ — pre-post",
  description: "Common questions about pre-post: speed, privacy, what it works with, and cost.",
  alternates: { canonical: "/faq" },
}

const faqs = [
  {
    q: "Is it really faster?",
    a: "Yes. Seconds, not the minutes agents take driving a browser.",
  },
  {
    q: "Who can see the visuals?",
    a: "Only people who can see your code.",
  },
  {
    q: "What does it work with?",
    a: "Next.js and Vite out of the box. Anything else, name the pages with --routes.",
  },
  {
    q: "Does it cost anything?",
    a: "No. Free and open source.",
  },
]

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
}

export default function FaqPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <PageHeader title="FAQ" />
      <dl className="space-y-6 text-[15px]">
        {faqs.map(({ q, a }) => (
          <div key={q} className="space-y-1">
            <dt className="text-neutral-800 font-medium">{q}</dt>
            <dd>{a}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}
