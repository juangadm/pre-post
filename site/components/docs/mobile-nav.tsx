"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import { Logo } from "@/components/logo"
import { pages, resources } from "@/lib/nav"

// Stands in for the sidebar below 981px.
export function MobileNav() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  useEffect(() => setOpen(false), [pathname])

  return (
    <nav aria-label="Site" className="min-[981px]:hidden px-4 sm:px-6 pt-4">
      <div className="flex items-center justify-between">
        <Link
          href="/"
          aria-label="pre-post home"
          className="text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
        >
          <Logo />
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="mobile-nav-links"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
          className="-mr-3 flex h-11 w-11 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 rounded-sm"
        >
          <span className="flex h-2 w-3 flex-col justify-between" aria-hidden="true">
            <span className={`block h-[1.5px] rounded-full bg-neutral-400 transition-transform duration-200 ${open ? "translate-y-[3.25px] rotate-45" : ""}`} />
            <span className={`block h-[1.5px] rounded-full bg-neutral-400 transition-transform duration-200 ${open ? "-translate-y-[3.25px] -rotate-45" : ""}`} />
          </span>
        </button>
      </div>

      <div
        id="mobile-nav-links"
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
        inert={!open}
      >
        <ul className="overflow-hidden flex flex-col font-[family-name:var(--font-departure)] text-[14px]">
          {pages.map((page) => (
            <li key={page.href}>
              <Link
                href={page.href}
                aria-current={pathname === page.href ? "page" : undefined}
                className="block py-1.5 text-neutral-500 aria-[current=page]:text-neutral-900 hover:text-neutral-800 transition-colors"
              >
                {page.label}
              </Link>
            </li>
          ))}
          {resources.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block py-1.5 text-neutral-400 hover:text-neutral-800 transition-colors"
              >
                {link.label} <span aria-hidden="true">↗</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  )
}
