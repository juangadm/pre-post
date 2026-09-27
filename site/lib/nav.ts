export const siteUrl = "https://prepost.juangabriel.org"

export interface NavSection {
  id: string
  label: string
}

export interface NavPage {
  href: string
  label: string
  sections?: NavSection[]
}

export interface NavLink {
  href: string
  label: string
}

// One source for the sidebar, the mobile menu and the sitemap.
export const pages: NavPage[] = [
  { href: "/", label: "Overview" },
  { href: "/install", label: "Install" },
  {
    href: "/how-it-works",
    label: "How it works",
    sections: [
      { id: "detect", label: "Detect" },
      { id: "capture", label: "Capture" },
      { id: "share", label: "Share" },
    ],
  },
  { href: "/commands", label: "Commands" },
  { href: "/faq", label: "FAQ" },
]

export const resources: NavLink[] = [
  { href: "https://github.com/juangadm/pre-post/releases", label: "Changelog" },
  { href: "https://github.com/juangadm/pre-post", label: "GitHub" },
]

export const npmUrl = "https://www.npmjs.com/package/@juangadm/pre-post"
