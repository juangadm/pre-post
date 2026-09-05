"use client"
import { useEffect, useState } from "react"
export default function Page() {
  const [t, setT] = useState("")
  useEffect(() => {
    const tick = () => setT(new Date().toISOString())
    tick()
    const id = setInterval(tick, 50)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <p className="font-mono text-3xl text-neutral-800">{t || "…"}</p>
    </div>
  )
}
