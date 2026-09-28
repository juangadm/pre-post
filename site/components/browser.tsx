"use client"

import { cva, type VariantProps } from "class-variance-authority"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

const browserVariants = cva("", {
  variants: {
    variant: {
      A: "",
      B: "",
    },
  },
  defaultVariants: {
    variant: "A",
  },
})

interface BrowserProps extends VariantProps<typeof browserVariants> {
  url?: string
  className?: string
  content?: "A" | "B"
}

export function BrowserChrome({ url = "localhost:3000" }: { url?: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 bg-neutral-50 border-b border-neutral-200">
      <div className="flex items-center gap-1">
        <div className="w-2 h-2 rounded-full bg-[--geist-red-600]" />
        <div className="w-2 h-2 rounded-full bg-[--geist-amber-600]" />
        <div className="w-2 h-2 rounded-full bg-[--geist-green-600]" />
      </div>
      <div className="flex-1">
        <div className="bg-neutral-100 rounded-full px-2 h-4 flex items-center">
          <span className="text-[8px] leading-none text-neutral-400">{url}</span>
        </div>
      </div>
    </div>
  )
}

const archGroups = [
  {
    pre: "#b8bab9",
    post: "#f4d02e",
    paths: [
      "M75 277 C75 188 93 143 119 144 C146 145 162 202 162 269",
      "M139 270 C140 170 157 100 183 103 C211 106 220 173 219 220",
      "M189 218 C192 142 211 105 234 108 C259 112 269 172 270 228",
    ],
  },
  {
    pre: "#60696d",
    post: "#0588b8",
    paths: [
      "M141 344 C141 229 145 77 164 70 C187 61 195 138 193 206",
      "M185 205 C187 127 199 57 220 59 C246 61 251 125 249 155",
      "M249 155 C257 94 274 74 292 92 C310 110 307 190 305 258",
      "M141 346 C138 275 158 241 181 245 C207 249 213 276 213 302",
      "M213 302 C215 229 237 195 261 199 C285 203 288 236 289 258",
    ],
  },
  {
    pre: "#85898a",
    post: "#e51636",
    paths: [
      "M45 246 C45 177 70 154 93 176 C113 195 121 222 122 247",
      "M122 247 C122 157 144 111 166 124 C193 139 198 185 201 217",
      "M201 217 C201 156 215 124 233 127 C256 130 260 181 259 229",
      "M259 229 C260 178 280 150 301 160 C325 173 329 234 329 284",
      "M329 284 C332 222 366 189 387 211 C408 231 410 260 410 269",
    ],
  },
  {
    pre: "#a2a8a6",
    post: "#0fa67b",
    paths: [
      "M99 379 C99 305 116 268 139 274 C164 281 176 316 176 331",
      "M141 346 C141 274 162 247 184 253 C209 259 214 285 213 302",
      "M175 332 C178 279 203 255 226 265 C247 275 251 304 252 322",
    ],
  },
] as const

const letterMarkers = [
  [45, 246, "T"], [75, 277, "G"], [122, 247, "H"],
  [141, 169, "O"], [193, 206, "R"], [201, 217, "L"],
  [249, 155, "K"], [233, 190, "V"], [259, 229, "D"],
  [289, 258, "B"], [329, 284, "X"], [410, 269, "I"],
  [141, 346, "N"], [176, 331, "Z"], [213, 302, "S"],
  [252, 322, "A"], [99, 379, "J"],
] as const

export function ArchArtwork({ colored, animated = false, replay = false }: { colored: boolean; animated?: boolean; replay?: boolean }) {
  const reduceMotion = useReducedMotion()
  const shouldAnimate = animated && !reduceMotion
  let pathNumber = 0

  return (
    <svg
      className="block h-full w-full"
      viewBox="0 0 440 440"
      role="img"
      aria-label={colored ? "Overlapping cyan, red, yellow, and green arches" : "The same arches in grayscale"}
    >
      <rect width="440" height="440" style={{ fill: "hsl(var(--background))" }} />
      {archGroups.map((group, groupIndex) => (
        <g key={groupIndex}>
          {group.paths.map((path, pathIndex) => {
            const index = pathNumber++
            // The opening keeps PRE restrained; both images animate together once inside the PR.
            const moving = shouldAnimate && (replay || colored || (groupIndex === 0 && pathIndex < 2) || (groupIndex === 3 && pathIndex === 0))
            return (
              <motion.path
                key={pathIndex}
                d={path}
                fill="none"
                stroke={colored ? group.post : group.pre}
                strokeWidth="19"
                strokeLinecap="round"
                opacity={colored ? 0.88 : 0.78}
                style={colored ? { mixBlendMode: "multiply" } : undefined}
                initial={moving ? { x: colored ? (index % 2 ? 24 : -24) : 0, y: colored ? -18 : -12, opacity: 0 } : false}
                animate={moving ? replay
                  ? { x: [colored ? (index % 2 ? 16 : -16) : (index % 2 ? -14 : 14), 0], y: [colored ? -12 : -10, 0], opacity: [colored ? 0.45 : 0.42, colored ? 0.88 : 0.78] }
                  : { x: 0, y: 0, opacity: colored ? 0.88 : 0.78 } : undefined}
                transition={moving ? replay
                  ? { duration: 0.65, ease: "easeOut", delay: colored ? 0.055 * index : 0.12 * pathIndex }
                  : { type: "spring", stiffness: 230, damping: 15, delay: colored ? 0.08 * index : 0.12 * pathIndex } : undefined}
              />
            )
          })}
        </g>
      ))}
      {letterMarkers.map(([x, y, letter], index) => (
        <motion.g
          key={index}
          initial={shouldAnimate && colored ? { opacity: 0, scale: 0.55 } : false}
          animate={shouldAnimate && colored ? replay ? { opacity: [0.55, 1], scale: [0.8, 1] } : { opacity: 1, scale: 1 } : undefined}
          transition={shouldAnimate && colored ? replay
            ? { duration: 0.5, ease: "easeOut", delay: 0.18 + index * 0.055 }
            : { type: "spring", stiffness: 300, damping: 17, delay: 0.18 + index * 0.075 } : undefined}
          style={{ transformOrigin: `${x}px ${y}px` }}
        >
          <circle cx={x} cy={y} r="11" fill={colored ? "#232627" : "#4d5254"} />
          <text
            x={x}
            y={y + 0.5}
            fill="#fff"
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="Arial, sans-serif"
            fontSize="12"
            fontWeight="700"
          >
            {letter}
          </text>
        </motion.g>
      ))}
    </svg>
  )
}

export function ContentA({ animated = false, replay = false }: { animated?: boolean; replay?: boolean } = {}) {
  return <ArchArtwork colored={false} animated={animated} replay={replay} />
}

export function ContentB({ animated = false, replay = false }: { animated?: boolean; replay?: boolean } = {}) {
  return <ArchArtwork colored animated={animated} replay={replay} />
}

const CONTENT_MAP: Record<string, () => React.JSX.Element> = {
  A: ContentA,
  B: ContentB,
}

export function Browser({ variant = "A", className, content }: BrowserProps) {
  const contentKey = content ?? variant ?? "A"

  return (
    <div
      className={cn(
        "w-full bg-transparent",
        browserVariants({ variant }),
        className
      )}
    >
      <div className="aspect-square overflow-hidden border border-[#d7d7d2] bg-background">
        {(CONTENT_MAP[contentKey] ?? ContentA)()}
      </div>
    </div>
  )
}
