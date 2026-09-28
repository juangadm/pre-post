export function Logo({ className }: { className?: string }) {
  return (
    <span className={`font-heading text-xl font-bold leading-none tracking-[-0.04em] text-neutral-900 ${className ?? ""}`}>
      pre<span className="text-neutral-400">/</span>post
    </span>
  )
}
