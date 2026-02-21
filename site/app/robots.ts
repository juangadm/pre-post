import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: "/components/",
      },
      {
        userAgent: [
          "GPTBot",
          "ChatGPT-User",
          "PerplexityBot",
          "ClaudeBot",
          "CCBot",
          "Google-Extended",
        ],
        allow: "/",
        disallow: "/components/",
      },
    ],
    sitemap: "https://site-puce-rho.vercel.app/sitemap.xml",
  }
}
