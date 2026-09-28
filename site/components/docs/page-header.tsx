export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="space-y-2">
      <h1 className="text-neutral-800 text-[22px] sm:text-[24px] font-bold leading-snug tracking-[-0.03em]">
        {title}
      </h1>
      {children && <p className="text-[16px] leading-relaxed text-neutral-700">{children}</p>}
    </header>
  )
}
