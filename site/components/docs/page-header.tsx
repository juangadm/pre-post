export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="space-y-2">
      <h1 className="text-neutral-800 text-[20px] sm:text-[22px] font-medium leading-snug tracking-tight">
        {title}
      </h1>
      {children && <p className="text-[15px]">{children}</p>}
    </header>
  )
}
