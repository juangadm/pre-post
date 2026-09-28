"use client"

import { useEffect, useState, useCallback } from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ContentA, ContentB } from "@/components/browser"
import { PullRequest } from "@/components/pull-request"
import { Terminal, type TerminalLine } from "@/components/terminal"

// ─── Phase definitions ───────────────────────────────────────────────

type Phase =
  | "idle"
  | "coding"
  | "command"
  | "output"
  | "capture"
  | "upload"
  | "pr_reveal"

const PHASE_ORDER: Phase[] = [
  "idle",
  "coding",
  "command",
  "output",
  "capture",
  "upload",
  "pr_reveal",
]

// Durations for timer-driven phases (coding/command use callbacks instead)
const PHASE_DURATIONS: Partial<Record<Phase, number>> = {
  idle: 500,
  output: 1000,
  capture: 1500,
  upload: 1400,
  pr_reveal: 4300,
}

function phaseIdx(phase: Phase) {
  return PHASE_ORDER.indexOf(phase)
}

function nextPhase(phase: Phase): Phase {
  return PHASE_ORDER[(phaseIdx(phase) + 1) % PHASE_ORDER.length]
}

// ─── Terminal line builder ───────────────────────────────────────────

function buildLines(
  phase: Phase,
  onCodingComplete: () => void,
  onCommandComplete: () => void,
): TerminalLine[] {
  const idx = phaseIdx(phase)

  const lines: TerminalLine[] = []

  // Phase 1 (idle): blinking cursor placeholder
  if (idx === 0) {
    return lines
  }

  // Phase 2 (coding): editing lines appear progressively
  if (idx >= 1) {
    lines.push({
      type: "prompt",
      text: "Editing app/page.tsx...",
      visible: true,
      typing: idx === 1,
      onTypingComplete: idx === 1 ? onCodingComplete : undefined,
    })
  }
  if (idx >= 2) {
    lines.push(
      { type: "output", text: "  Updated navigation layout", visible: true },
      { type: "output", text: "  Added feature cards", visible: true },
      { type: "blank", text: "", visible: true },
    )
  }

  // Phase 3 (command): /pre-post typing
  if (idx >= 2) {
    lines.push({
      type: "prompt",
      text: "/pre-post",
      visible: true,
      typing: idx === 2,
      onTypingComplete: idx === 2 ? onCommandComplete : undefined,
    })
  }

  // Phase 4 (output): detection lines
  if (idx >= 3) {
    lines.push(
      { type: "blank", text: "", visible: true },
      { type: "output", text: "Detecting routes... found /", visible: true },
      { type: "output", text: "Capturing / (desktop)...", visible: true },
    )
  }

  // Phase 6 (upload): success
  if (idx >= 5) {
    lines.push(
      { type: "blank", text: "", visible: true },
      { type: "success", text: "Added to PR #42", visible: true },
    )
  }

  return lines
}

// ─── AnimatedBrowser ─────────────────────────────────────────────────

function AnimatedBrowser({
  showContentB,
  replay,
  capture,
}: {
  showContentB: boolean
  replay: boolean
  capture: boolean
}) {
  return (
    <div className="w-full bg-transparent relative">
      <div className="aspect-square overflow-hidden border border-[#d7d7d2] bg-background relative">
        <AnimatePresence>
          {showContentB && (
            <motion.div
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              <ContentB animated replay={replay} />
            </motion.div>
          )}
        </AnimatePresence>
        {capture && <CaptureFlash variant="post" delay={0.55} />}
      </div>
    </div>
  )
}

function CaptureFlash({ variant, delay }: { variant: "pre" | "post"; delay: number }) {
  return (
    <motion.div
      data-capture-flash={variant}
      className="pointer-events-none absolute inset-0 bg-background"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 0.88, 0] }}
      transition={{ duration: 0.5, delay }}
      aria-hidden="true"
    />
  )
}

function VideoBadge({ visible, reduceMotion }: { visible: boolean; reduceMotion: boolean | null }) {
  return (
    <motion.span
      aria-hidden="true"
      className="pointer-events-none absolute right-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-sm border border-neutral-300 bg-white/90 text-neutral-600"
      initial={false}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.2, delay: visible && !reduceMotion ? 0.7 : 0 }}
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden="true">
        <path d="M5.5 3.5 12 8l-6.5 4.5v-9Z" fill="currentColor" />
      </svg>
    </motion.span>
  )
}

// ─── Hero ────────────────────────────────────────────────────────────

interface HeroProps {
  phase?: Phase
  onPhaseChange?: (phase: Phase) => void
  autoPlay?: boolean
}

export function Hero({ phase: controlledPhase, onPhaseChange, autoPlay = true }: HeroProps) {
  const phase = controlledPhase ?? "idle"
  const idx = phaseIdx(phase)
  const reduceMotion = useReducedMotion()
  const [replayInPR, setReplayInPR] = useState(false)

  useEffect(() => {
    if (phase !== "pr_reveal" || reduceMotion) {
      setReplayInPR(false)
      return
    }
    const timer = setTimeout(() => setReplayInPR(true), 750)
    return () => clearTimeout(timer)
  }, [phase, reduceMotion])

  // Advance phase helper
  const advance = useCallback(() => {
    onPhaseChange?.(nextPhase(phase))
  }, [phase, onPhaseChange])

  // Timer-driven phases
  useEffect(() => {
    if (!autoPlay || !onPhaseChange) return
    // coding and command phases advance via typing callback, not timer
    if (phase === "coding" || phase === "command") return

    const duration = PHASE_DURATIONS[phase]
    if (duration == null) return

    const timer = setTimeout(advance, duration)
    return () => clearTimeout(timer)
  }, [phase, autoPlay, onPhaseChange, advance])

  // Callback-driven phase advances
  const onCodingComplete = useCallback(() => {
    if (autoPlay) onPhaseChange?.("command")
  }, [autoPlay, onPhaseChange])

  const onCommandComplete = useCallback(() => {
    if (autoPlay) onPhaseChange?.("output")
  }, [autoPlay, onPhaseChange])

  // ─── Derived state ───────────────────────────────────────────────
  const showContentB = idx >= 1
  const showPR = phase === "pr_reveal"

  // Terminal lines
  const terminalLines = buildLines(phase, onCodingComplete, onCommandComplete)

  return (
    <div className="mx-auto w-full max-w-[540px] px-3 sm:px-4">
      <div className="relative h-[315px] sm:h-[385px]">
        {/* The PR frame takes over the same canvas; its table leaves space for these exact panels. */}
        <motion.div
          data-pr-shell
          className="absolute inset-0 z-0"
          initial={false}
          animate={{ opacity: showPR ? 1 : 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.25 }}
          aria-hidden={!showPR}
        >
          <PullRequest tab="preview" interactive={false} artworkInHero />
        </motion.div>

        <div data-hero-source className="absolute inset-x-0 top-0 z-10 grid grid-cols-2 gap-0.5 sm:gap-1">
          <motion.div
            data-pr-art="pre"
            className="relative origin-top"
            animate={{ x: showPR ? 6 : 0, y: showPR ? 126 : 0, scale: showPR ? 0.88 : 1 }}
            transition={{ type: "spring", bounce: 0.1, duration: reduceMotion ? 0 : 0.65 }}
          >
            <div className="relative aspect-square overflow-hidden border border-[#d7d7d2] bg-background">
              <ContentA animated replay={replayInPR} />
              {phase === "capture" && !reduceMotion && <CaptureFlash variant="pre" delay={0.12} />}
            </div>
            <VideoBadge visible={showPR} reduceMotion={reduceMotion} />
          </motion.div>

          <motion.div
            data-pr-art="post"
            className="relative origin-top"
            animate={{ x: showPR ? -6 : 0, y: showPR ? 126 : 0, scale: showPR ? 0.88 : 1 }}
            transition={{ type: "spring", bounce: 0.1, duration: reduceMotion ? 0 : 0.65, delay: reduceMotion ? 0 : 0.06 }}
          >
            <AnimatedBrowser showContentB={showContentB} replay={replayInPR} capture={phase === "capture" && !reduceMotion} />
            <VideoBadge visible={showPR} reduceMotion={reduceMotion} />
          </motion.div>
        </div>

        <motion.div
          className="pointer-events-none absolute inset-x-0 top-0 z-20 grid grid-cols-2 gap-0.5 sm:gap-1"
          initial={false}
          animate={{ opacity: showPR ? 0 : 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
          aria-hidden={showPR}
        >
          <div className="flex h-6 items-center justify-between border border-[#d7d7d2] bg-background px-2 text-[10px] leading-none">
            <span className="font-heading font-semibold text-neutral-800">pre</span>
            <span className="font-mono text-neutral-500">main</span>
          </div>
          <div className="flex h-6 items-center justify-between border border-[#d7d7d2] bg-background px-2 text-[10px] leading-none">
            <span className="font-heading font-semibold text-neutral-800">post</span>
            <span className="font-mono text-neutral-500">feature/ui</span>
          </div>
        </motion.div>

        <motion.div
          className="absolute inset-x-0 bottom-0 z-20 h-[115px]"
          initial={false}
          animate={{ opacity: showPR ? 0 : 1, y: showPR ? 8 : 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.25 }}
          style={{ pointerEvents: showPR ? "none" : "auto" }}
          aria-hidden={showPR}
        >
          <Terminal lines={terminalLines} className="h-full w-full" compact />
        </motion.div>
      </div>
    </div>
  )
}

// ─── Auto-playing wrapper (used by page.tsx) ─────────────────────────

export function AutoPlayHero() {
  const [phase, setPhase] = useState<Phase>("idle")

  return <Hero phase={phase} onPhaseChange={setPhase} autoPlay />
}

// Re-export types for compatibility
export type HeroState = Phase
export const STATE_ORDER = PHASE_ORDER
