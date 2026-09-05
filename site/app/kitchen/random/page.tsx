"use client"
import { useEffect, useState } from "react"
export default function Page() {
  const [v, setV] = useState<number[]>([])
  useEffect(() => { setV(Array.from({ length: 12 }, () => Math.random())) }, [])
  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="flex gap-2 items-end h-64">
        {v.map((n, i) => (
          <div key={i} style={{ height: `${20 + n * 220}px` }} className="w-8 bg-violet-500 rounded-t" />
        ))}
      </div>
    </div>
  )
}
