interface SectionProps {
  id?: string
  title: string
  children: React.ReactNode
}

export function Section({ id, title, children }: SectionProps) {
  return (
    <section id={id} className="scroll-mt-8 space-y-3">
      <h2 className="text-neutral-800 text-[15px] font-heading font-bold tracking-[-0.03em] flex items-center gap-4 after:content-[''] after:flex-1 after:h-px after:bg-neutral-200">
        {title}
      </h2>
      <div className="space-y-3 text-[15px]">{children}</div>
    </section>
  )
}
