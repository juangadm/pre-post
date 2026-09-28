import React from "react"
import type { Metadata } from "next"
import { Courier_Prime, Space_Grotesk } from "next/font/google"

import "./globals.css"

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-heading",
})

const courierPrime = Courier_Prime({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-code",
})

const siteUrl = "https://prepost.juangabriel.org"
const description =
  "pre-post is a visual diff tool for pull requests. One command detects the routes your branch changed, captures each one before and after, pixel-diffs the pair, and puts the result at the top of the PR. Both sides come from the same kind of environment, so the diff only shows what the branch changed. Use as a Claude Code skill or CLI tool."

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
    "pixel diff",
    "pre-post",
  ],
  authors: [{ name: "Juan Gabriel", url: "https://juangabriel.org" }],
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
        url: "https://juangabriel.org",
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
      <body className={`${spaceGrotesk.variable} ${courierPrime.variable} font-sans antialiased`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  )
}
