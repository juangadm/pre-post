import Image from "next/image"
export default function Page() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <Image src="/placeholder.jpg" alt="placeholder" width={420} height={280} className="rounded-xl" />
    </div>
  )
}
