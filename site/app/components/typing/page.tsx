import { TypingText } from "@/components/typing-text"

export default function TypingPage() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-8">
      <div className="flex flex-col items-center gap-8">
        <h1 className="text-neutral-800 text-lg">Typing Text Component</h1>
        <TypingText text="pre-post pr" className="text-neutral-500 font-mono text-2xl" />
      </div>
    </div>
  )
}
