import { expect, test } from "@playwright/test"

const pages = [
  { href: "/", label: "Overview" },
  { href: "/install", label: "Install" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/commands", label: "Commands" },
  { href: "/faq", label: "FAQ" },
]

test("every page loads", async ({ request }) => {
  for (const { href } of pages) {
    expect((await request.get(href)).status(), href).toBe(200)
  }
})

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test("moving between pages keeps the sidebar, reloads nothing, shifts nothing", async ({ page }) => {
    await page.goto("/")
    const sidebar = page.locator("nav.fixed")
    await expect(sidebar).toBeVisible()

    // Mark the document and the sidebar node; a reload or remount would lose them.
    await page.evaluate(() => {
      ;(window as any).__loaded = true
      ;(document.querySelector("nav.fixed") as any).__node = true
      ;(window as any).__shifts = 0
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          // The section list under "How it works" expands by design; only count shifts outside the sidebar
          const outside = entry.sources.some((s: any) => s.node && !s.node.closest?.("nav"))
          if (outside && !entry.hadRecentInput) (window as any).__shifts += entry.value
        }
      }).observe({ type: "layout-shift" })
    })

    const position = () =>
      page.evaluate(() => ({
        nav: document.querySelector("nav.fixed")!.getBoundingClientRect().left,
        main: document.querySelector("main")!.getBoundingClientRect().left,
        top: document.querySelector("main h1")!.getBoundingClientRect().top,
      }))
    const start = await position()

    for (const { href, label } of [...pages.slice(1), pages[0]]) {
      await sidebar.getByRole("link", { name: label, exact: true }).click()
      await expect(page).toHaveURL(href)
      await expect(sidebar.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page")
      expect(await position()).toEqual(start)
    }

    const state = await page.evaluate(() => ({
      loaded: (window as any).__loaded,
      sameNode: (document.querySelector("nav.fixed") as any).__node,
    }))
    expect(state).toEqual({ loaded: true, sameNode: true })
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => (window as any).__shifts)).toBe(0)
  })

  test("How it works lists its sections, starting on the first", async ({ page }) => {
    await page.goto("/how-it-works")
    const toc = page.locator("nav.fixed [data-id]")
    await expect(toc).toHaveCount(3)
    await expect(page.locator('nav.fixed a[aria-current="location"]')).toHaveText("Detect")
  })
})

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test("the menu opens, navigates and closes", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator("nav.fixed")).toBeHidden()
    await page.getByRole("button", { name: "Open menu" }).click()
    await page.locator("#mobile-nav-links").getByRole("link", { name: "FAQ" }).click()
    await expect(page).toHaveURL("/faq")
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false")
  })
})
