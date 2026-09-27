export function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="text-neutral-800 bg-neutral-100 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[13px]">
      {children}
    </code>
  )
}
