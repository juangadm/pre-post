export function Footer() {
  return (
    <footer className="mt-16 pt-6 border-t border-neutral-200 flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-400">
      <span className="flex items-center gap-1.5">
        <img src="https://juangabriel.org/favicon-32x32.png" alt="" width={14} height={14} className="rounded-sm" />
        Made by{" "}
        <a href="https://juangabriel.org" target="_blank" rel="noopener noreferrer" className="text-neutral-600 hover:underline">
          Juan Gabriel
        </a>
      </span>
    </footer>
  )
}
