export default function Page() {
  return (
    <div className="min-h-screen bg-slate-900 p-8">
      {Array.from({ length: 60 }).map((_, i) => (
        <p key={i} className="text-slate-300 py-3 border-b border-slate-800">Row {i + 1} — a tall page to exercise the full-page height cap.</p>
      ))}
    </div>
  )
}
