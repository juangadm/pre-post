export default function Page() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <form className="flex flex-col gap-4 w-80">
        <input className="border border-neutral-300 rounded px-3 py-2" placeholder="Email" />
        <select className="border border-neutral-300 rounded px-3 py-2"><option>Desktop</option><option>Mobile</option></select>
        <label className="flex gap-2 text-neutral-600"><input type="checkbox" defaultChecked /> Publish screenshots</label>
        <button className="bg-blue-600 text-white rounded px-3 py-2">Submit</button>
      </form>
    </div>
  )
}
