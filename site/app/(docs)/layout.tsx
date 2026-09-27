import { Footer } from "@/components/docs/footer"
import { MobileNav } from "@/components/docs/mobile-nav"
import { SideNav } from "@/components/docs/side-nav"

// Shared by every page. Navigating swaps only <main>; the nav never remounts.
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-[#FBFBFB] text-neutral-500">
      <MobileNav />
      <SideNav />
      <div className="flex-1 flex min-[981px]:max-[1079px]:ml-[13rem]">
        {/* The footer sits at the bottom on short pages, so it doesn't jump between them */}
        <div className="w-full max-w-[640px] mx-auto px-4 sm:px-6 pt-8 pb-8 min-[981px]:pt-12 flex flex-col">
          <main className="flex-1 space-y-10 sm:space-y-12">{children}</main>
          <Footer />
        </div>
      </div>
    </div>
  )
}
