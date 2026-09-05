export default function Page() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <form className="flex flex-col gap-4 w-80">
        <input className="border border-slate-600 rounded px-3 py-2" placeholder="Email" />
        <select className="border border-slate-600 rounded px-3 py-2"><option>Desktop</option><option>Mobile</option></select>
        <label className="flex gap-2 text-slate-300"><input type="checkbox" defaultChecked /> Publish screenshots</label>
        <button className="bg-blue-600 text-white rounded px-3 py-2">Submit</button>
      </form>
    </div>
  )
}
