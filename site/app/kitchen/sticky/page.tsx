export default function Page() {
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 h-16 bg-indigo-600 text-white flex items-center px-6 text-lg z-10">Sticky header</header>
      {Array.from({ length: 12 }).map((_, i) => (
        <section key={i} className="h-40 border-b border-neutral-200 px-6 py-4 text-neutral-600">Section {i + 1}</section>
      ))}
    </div>
  )
}
