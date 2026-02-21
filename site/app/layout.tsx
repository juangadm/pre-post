import React from "react"
import type { Metadata } from "next"
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google"
import localFont from "next/font/local"

import "./globals.css"

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
})

const departureMono = localFont({
  src: "./fonts/DepartureMono-Regular.woff2",
  variable: "--font-departure",
})

const vanillaCream = localFont({
  src: "./fonts/VanillaCreamOx-Regular.otf",
  variable: "--font-vanilla-cream",
})

const biroScript = localFont({
  src: "./fonts/Biro_Script_reduced.otf",
  variable: "--font-biro-script",
})

const siteUrl = "https://site-puce-rho.vercel.app"
const description =
  "pre-post is a visual diff tool that captures before-and-after screenshots of web pages for pull requests. Reads your git diff, detects changed routes, and screenshots them automatically. Use as a Claude Code skill or CLI tool."

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  alternates: {
    canonical: "/",
  },
  title: "pre-post — visual diff tool for PRs",
  description,
  keywords: [
    "visual diff",
    "screenshot comparison",
    "PR screenshots",
    "before and after",
    "Claude Code skill",
    "visual regression",
    "web screenshot tool",
    "pull request screenshots",
    "Playwright screenshots",
    "pre-post",
  ],
  authors: [{ name: "Juan Gabriel", url: "https://juangabriel.xyz" }],
  creator: "Juan Gabriel",
  openGraph: {
    title: "pre-post — visual diff tool for PRs",
    description,
    url: siteUrl,
    siteName: "pre-post",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "pre-post — visual diff tool for PRs",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "pre-post — visual diff tool for PRs",
    description,
    images: ["/opengraph-image.png"],
  },
  icons: {
    icon: "/icon",
  },
}

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      name: "pre-post",
      url: siteUrl,
      description,
    },
    {
      "@type": "SoftwareApplication",
      name: "pre-post",
      description,
      url: siteUrl,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Cross-platform",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      author: {
        "@type": "Person",
        name: "Juan Gabriel",
        url: "https://juangabriel.xyz",
      },
    },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${ibmPlexSans.variable} ${ibmPlexMono.variable} ${departureMono.variable} ${vanillaCream.variable} ${biroScript.variable} font-sans antialiased`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  )
}
