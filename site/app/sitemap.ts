import type { MetadataRoute } from "next"
import { pages, siteUrl } from "@/lib/nav"

export default function sitemap(): MetadataRoute.Sitemap {
  return pages.map((page) => ({
    url: `${siteUrl}${page.href === "/" ? "" : page.href}`,
    lastModified: new Date(),
    changeFrequency: "monthly",
    priority: page.href === "/" ? 1.0 : 0.7,
  }))
}
