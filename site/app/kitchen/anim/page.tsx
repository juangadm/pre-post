export default function Page() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <style>{`@keyframes spin360{from{transform:rotate(0)}to{transform:rotate(360deg)}}
      .spinner{animation:spin360 1.2s linear infinite}
      @keyframes pulse2{0%,100%{opacity:1}50%{opacity:.2}}
      .pulser{animation:pulse2 .9s ease-in-out infinite}`}</style>
      <div className="flex gap-10 items-center">
        <div className="spinner w-24 h-24 border-8 border-blue-500 border-t-transparent rounded-full" />
        <div className="pulser w-24 h-24 bg-pink-500 rounded-lg" />
      </div>
    </div>
  )
}
