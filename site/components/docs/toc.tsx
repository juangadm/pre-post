"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import type { NavSection } from "@/lib/nav"

interface TocProps {
  href: string
  sections: NavSection[]
  open: boolean
}

// The page's sections, listed under its sidebar link. Expands when the page is
// open and marks the section in view with a dark bar that slides along a rail.
export function Toc({ href, sections, open }: TocProps) {
  const listRef = useRef<HTMLUListElement>(null)
  const [current, setCurrent] = useState(sections[0]?.id)

  useEffect(() => {
    if (!open) return
    let frame = 0
    const update = () => {
      const line = window.innerHeight * 0.3
      let next = sections[0]?.id
      for (const { id } of sections) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= line) next = id
      }
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
      // A page too short to scroll starts on its first section
      if (atBottom && window.scrollY > 0) next = sections[sections.length - 1]?.id
      setCurrent(next)
    }
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }, [open, sections])

  useEffect(() => {
    const list = listRef.current
    const item = list?.querySelector<HTMLElement>(`[data-id="${current}"]`)
    if (!list || !item) return
    list.style.setProperty("--active-top", `${item.offsetTop}px`)
    list.style.setProperty("--active-height", `${item.offsetHeight}px`)
  }, [current, open])

  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      inert={!open}
    >
      <div className="overflow-hidden">
        <ul
          ref={listRef}
          className="relative mt-1.5 mb-2 ml-0.5 pl-3 flex flex-col gap-1.5 text-[12px] leading-snug before:absolute before:left-0 before:inset-y-0 before:w-[1.5px] before:rounded-full before:bg-neutral-200 after:absolute after:left-0 after:top-0 after:w-[1.5px] after:rounded-full after:bg-neutral-800 after:h-[var(--active-height,0px)] after:translate-y-[var(--active-top,0px)] after:transition-transform after:duration-300"
        >
          {sections.map(({ id, label }) => (
            <li key={id} data-id={id}>
              <Link
                href={`${href}#${id}`}
                aria-current={open && current === id ? "location" : undefined}
                className="block text-neutral-400 hover:text-neutral-700 aria-[current=location]:text-neutral-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 rounded-sm"
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
