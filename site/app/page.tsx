import { AutoPlayHero } from "@/components/hero";
import { Code } from "@/components/code";
import { Logo } from "@/components/logo";

export default function Page() {
  return (
    <div className="min-h-screen bg-[#FBFBFB] text-neutral-500">
      <main className="py-10 sm:py-16">
        <article>
        {/* Header - constrained width */}
        <div className="max-w-[640px] mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between mb-4">
            <a
              href="/pre-post"
              className="text-neutral-800 hover:text-neutral-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
            >
              <h1>
                <Logo />
              </h1>
            </a>
            <nav className="flex items-center gap-2.5 sm:gap-4 text-[13px] sm:text-sm font-[family-name:var(--font-departure)]">
              <a
                href="#install"
                className="text-neutral-500 hover:text-neutral-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
              >
                Install
              </a>
              <a
                href="#skill"
                className="text-neutral-500 hover:text-neutral-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
              >
                Skill
              </a>
              <a
                href="#options"
                className="text-neutral-500 hover:text-neutral-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
              >
                Options
              </a>
              <a
                href="https://github.com/juangadm/pre-post"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="text-neutral-500 hover:text-neutral-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-3.5 h-3.5"
                  aria-hidden="true"
                >
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                </svg>
              </a>
            </nav>
          </div>
          <p className="mb-8 sm:mb-12 text-[14px] sm:text-[15px]">
            One command for visual PR reviews. Pre-post detects the routes
            your branch changed, screenshots them on production and on your
            dev server, and posts the diff as a single PR comment.
          </p>
        </div>

        {/* Animation - wider, extra padding on mobile for transformed elements */}
        <div className="mb-10 sm:mb-16 px-8 sm:px-0">
          <AutoPlayHero />
        </div>

        {/* Content - constrained width */}
        <div className="max-w-[640px] mx-auto px-4 sm:px-6 space-y-8 sm:space-y-10">
          <section className="space-y-3">
            <h2 className="text-neutral-800 text-[14px] font-[family-name:var(--font-departure)] flex items-center gap-4 after:content-[''] after:flex-1 after:h-px after:bg-neutral-200">How it works</h2>
            <ol className="text-sm space-y-2 list-decimal list-inside">
              <li>Make your UI changes</li>
              <li>Say <code className="text-neutral-800 bg-neutral-50 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[14px]">/pre-post</code> in Claude Code, or run <code className="text-neutral-800 bg-neutral-50 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[14px]">pre-post pr</code></li>
              <li>Pre-post diffs your branch against main, then follows the import graph to every route you touched</li>
              <li>It captures each route twice — production (Pre) and your dev server (Post), desktop and mobile</li>
              <li>It pixel-diffs each pair and crops the changed region</li>
              <li>One sticky comment lands on the PR, updated in place on every run</li>
            </ol>
            <p className="text-sm text-neutral-400">
              Next.js App and Pages Router, Vite, and monorepos are detected automatically.
              The Pre side can be any reachable URL — Vercel, Netlify, or your own host.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-neutral-800 text-[14px] font-[family-name:var(--font-departure)] flex items-center gap-4 after:content-[''] after:flex-1 after:h-px after:bg-neutral-200">What&apos;s different</h2>
            <p className="text-sm">
              Pre-post started as a fork of Vercel&apos;s{" "}
              <a
                href="https://github.com/vercel-labs/before-and-after"
                target="_blank"
                rel="noopener noreferrer"
                className="text-neutral-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
              >
                before-and-after
              </a>
              . The original required you to manually pass two URLs. Pre-post
              reads your <code className="text-neutral-800 bg-neutral-50 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[14px]">git diff</code>,
              detects which routes changed, captures both sides automatically —
              desktop and mobile, at 2x retina — then pixel-diffs each pair and
              posts a single comment on the PR.
            </p>
            <p className="text-sm">
              Under the hood, it uses{" "}
              <a
                href="https://playwright.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-neutral-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
              >
                Playwright
              </a>{" "}
              instead of Vercel&apos;s agent-browser. It freezes the clock, finishes
              animations, and waits for fonts, images, and layout to settle before
              each capture, so a screenshot only changes when the page does.
            </p>
          </section>

          <section id="install" className="scroll-mt-8 space-y-3">
            <h2 className="text-neutral-800 text-[14px] font-[family-name:var(--font-departure)] flex items-center gap-4 after:content-[''] after:flex-1 after:h-px after:bg-neutral-200">Install</h2>
            <p className="text-sm">
              Nothing to install. The first run downloads the CLI and the Chromium
              headless shell. You need Node 20+ and a GitHub token — either{" "}
              <code className="text-neutral-800 bg-neutral-50 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[14px]">gh auth login</code>{" "}
              or <code className="text-neutral-800 bg-neutral-50 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[14px]">GH_TOKEN</code>.
            </p>
            <Code>npx -y @juangadm/pre-post@latest pr</Code>
          </section>

          <section id="skill" className="scroll-mt-8 space-y-3">
            <h2 className="text-neutral-800 text-[14px] font-[family-name:var(--font-departure)] flex items-center gap-4 after:content-[''] after:flex-1 after:h-px after:bg-neutral-200">Add Skill</h2>
            <p className="text-sm">
              Show Claude Code how and when to take pre and post screenshots. The skill
              runs the one command and reports the summary and the comment link — it never
              opens the images, so screenshots stay out of the model&apos;s context. Say{" "}
              <code className="text-neutral-800 bg-neutral-50 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[14px]">
                /pre-post
              </code>{" "}
              after a UI change.
            </p>
            <Code>npx skills add juangadm/pre-post -y</Code>
          </section>

          <section id="options" className="scroll-mt-8">
            <details>
              <summary className="text-neutral-800 text-[14px] font-[family-name:var(--font-departure)] cursor-pointer select-none list-none flex items-center gap-1.5 after:content-[''] after:flex-1 after:h-px after:bg-neutral-200 [&::-webkit-details-marker]:hidden">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-4 h-4 transition-transform [[open]>&]:rotate-90"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
                Options
              </summary>
              <div className="mt-4 space-y-6">
                <div className="space-y-2">
                  <p className="text-sm">
                    First run in a repo — the production URL is saved to{" "}
                    <code className="text-neutral-800 bg-neutral-50 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[14px]">.pre-post.json</code>
                  </p>
                  <Code>pre-post pr --before https://acme.com</Code>
                </div>

                <div className="space-y-2">
                  <p className="text-sm">
                    Skip detection and name the routes yourself
                  </p>
                  <Code>pre-post pr --routes /pricing,/docs</Code>
                </div>

                <div className="space-y-2">
                  <p className="text-sm">
                    Custom viewports (default is desktop + mobile)
                  </p>
                  <Code>pre-post pr --viewports desktop,1440x900</Code>
                </div>

                <div className="space-y-2">
                  <p className="text-sm">
                    Capture and diff locally without posting anything
                  </p>
                  <Code>pre-post pr --dry-run</Code>
                </div>

                <div className="space-y-2">
                  <p className="text-sm">Machine-readable output</p>
                  <Code>pre-post pr --json</Code>
                </div>

                <div className="space-y-2">
                  <p className="text-sm">
                    Compare any two URLs, no PR involved
                  </p>
                  <Code>pre-post https://acme.com http://localhost:3000 --routes /pricing</Code>
                </div>

                <div className="space-y-2">
                  <p className="text-sm">
                    Use existing images instead of capturing URLs
                  </p>
                  <Code>pre-post before.png after.png</Code>
                </div>

                <div className="space-y-2">
                  <p className="text-sm">
                    Check which routes this branch touches, or why a run cannot start
                  </p>
                  <Code>pre-post detect</Code>
                  <Code>pre-post doctor</Code>
                </div>

                <div className="space-y-2">
                  <p className="text-sm">
                    Sign in once to a protected site — the session is reused
                  </p>
                  <Code>pre-post login https://staging.acme.com</Code>
                </div>

                <div className="space-y-2">
                  <p className="text-sm">Clean up old screenshots</p>
                  <Code>pre-post prune --days 90</Code>
                  <p className="text-sm mt-3">
                    Screenshots are published to a{" "}
                    <code className="text-neutral-800 bg-neutral-50 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[14px]">pre-post-assets</code>{" "}
                    branch in the same repository, one commit per run, and served via
                    GitHub blob URLs. Nothing is committed to the PR branch, so no CI
                    runs, and the images render on private repos.{" "}
                    <code className="text-neutral-800 bg-neutral-50 px-1 sm:px-1.5 py-0.5 rounded font-mono text-[12px] sm:text-[14px]">prune</code>{" "}
                    removes images for PRs closed more than 90 days ago.
                  </p>
                </div>
              </div>
            </details>
          </section>
        </div>

        {/* Acknowledgements */}
        <div className="max-w-[640px] mx-auto px-4 sm:px-6 mt-10 sm:mt-16 pt-6 sm:pt-8">
          <section className="space-y-1">
            <p className="text-xs text-neutral-400">Acknowledgements</p>
            <p className="text-xs text-neutral-400">
              Built on{" "}
              <a
                href="https://github.com/vercel-labs/before-and-after"
                target="_blank"
                rel="noopener noreferrer"
                className="text-neutral-500 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
              >
                before-and-after
              </a>
              {" "}by{" "}
              <a
                href="https://x.com/jamesvclements"
                target="_blank"
                rel="noopener noreferrer"
                className="text-neutral-500 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
              >
                James Clements
              </a>
              {" "}at{" "}
              <a
                href="https://github.com/vercel-labs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-neutral-500 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 rounded-sm"
              >
                Vercel Labs
              </a>
              .
            </p>
          </section>
        </div>
        </article>

        {/* FAQ — visually hidden, structured for AI search extraction */}
        <section className="sr-only" aria-label="Frequently asked questions">
          <h2>FAQ</h2>
          <dl>
            <dt>What is pre-post?</dt>
            <dd>
              pre-post is a visual diff tool for pull requests. One command detects
              the routes your branch changed, captures them on production and on your
              dev server at desktop and mobile in 2x retina quality, pixel-diffs each
              pair, and posts a single comment on the PR.
            </dd>
            <dt>How do I install pre-post?</dt>
            <dd>
              Nothing to install. Run npx -y @juangadm/pre-post@latest pr. You need
              Node 20+ and a GitHub token, from gh auth login or GH_TOKEN. To add it
              as a Claude Code skill, run npx skills add juangadm/pre-post -y.
            </dd>
            <dt>How does pre-post work?</dt>
            <dd>
              Make your UI changes, then say /pre-post in Claude Code or run pre-post
              pr. It diffs your branch against main and follows the import graph to
              every affected route, screenshots each one on production (Pre) and your
              dev server (Post), pixel-diffs them, publishes the images to a
              pre-post-assets branch, and updates one sticky comment on the PR.
            </dd>
            <dt>What makes pre-post different from before-and-after?</dt>
            <dd>
              pre-post is a fork of Vercel Labs' before-and-after. The original
              required manually passing two URLs. pre-post detects the changed routes
              from your git diff, captures desktop and mobile at 2x retina, pixel-diffs
              each pair, and posts the result to the PR itself. It uses Playwright with
              a frozen clock, finished animations, and settled fonts and layout, so a
              screenshot only changes when the page does.
            </dd>
          </dl>
        </section>
      </main>

      <footer className="py-6 text-sm text-neutral-400 flex justify-center">
        <div className="w-full max-w-[640px] px-4 sm:px-6 flex justify-between items-center flex-wrap gap-4">
          <div className="flex items-center gap-1.5">
            <img
              src="https://juangabriel.xyz/favicon.ico"
              alt=""
              width={16}
              height={16}
              className="rounded-sm"
            />
            Made by{" "}
            <a
              href="https://juangabriel.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-800 hover:underline hover:font-medium transition-all"
            >
              Juan Gabriel
            </a>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs font-[family-name:var(--font-departure)]">v0.3.0</span>
            <a
              href="https://www.npmjs.com/package/@juangadm/pre-post"
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-400 hover:text-neutral-800 transition-colors"
            >
              npm
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
