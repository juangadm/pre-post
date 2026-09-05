export default function Page() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <svg width="320" height="320" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" fill="none" stroke="#0ea5e9" strokeWidth="6" strokeDasharray="60 200">
          <animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="1.5s" repeatCount="indefinite" />
        </circle>
        <rect x="35" y="35" width="30" height="30" fill="#f43f5e" />
      </svg>
    </div>
  )
}
