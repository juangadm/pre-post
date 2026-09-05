export default function Page() {
  return (
    <div className="min-h-screen bg-white p-8">
      {Array.from({ length: 60 }).map((_, i) => (
        <p key={i} className="text-neutral-600 py-3 border-b border-neutral-100">Row {i + 1} — a tall page to exercise the full-page height cap.</p>
      ))}
    </div>
  )
}
