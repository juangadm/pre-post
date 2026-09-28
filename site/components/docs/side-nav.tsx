"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Logo } from "@/components/logo"
import { Toc } from "@/components/docs/toc"
import { npmUrl, pages, resources } from "@/lib/nav"
import { version } from "../../../package.json"

const linkClass =
  "block py-[3px] text-neutral-500 hover:text-neutral-800 aria-[current=page]:text-neutral-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 rounded-sm"

// Lives in the docs layout, so it stays mounted while pages change beside it.
export function SideNav() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Site"
      className="hidden min-[981px]:flex flex-col fixed top-12 bottom-4 left-[max(1rem,50%_-_32rem)] w-44 px-2.5"
    >
      <Link
        href="/"
        aria-label="pre-post home"
        className="mb-6 self-start text-neutral-800 hover:text-neutral-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
      >
        <Logo />
      </Link>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide font-sans text-[13px]">
        <ul className="flex flex-col gap-0.5">
          {pages.map((page) => {
            const active = pathname === page.href
            return (
              <li key={page.href}>
                <Link
                  href={page.href}
                  aria-current={active ? "page" : undefined}
                  className={linkClass}
                >
                  {page.label}
                </Link>
                {page.sections && (
                  <Toc href={page.href} sections={page.sections} open={active} />
                )}
              </li>
            )
          })}
        </ul>

        <p className="mt-5 mb-1 text-[11px] text-neutral-400">Resources</p>
        <ul className="flex flex-col gap-0.5">
          {resources.map((link) => (
            <li key={link.href}>
              <a href={link.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {link.label} <span aria-hidden="true">↗</span>
              </a>
            </li>
          ))}
        </ul>

        <a
          href={npmUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-block text-[11px] text-neutral-400 underline decoration-dotted underline-offset-2 hover:text-neutral-600 transition-colors"
        >
          v{version} on npm
        </a>
      </div>
    </nav>
  )
}
