interface RefTableProps {
  head: [string, string]
  rows: [string, string][]
}

// Two columns: something to type, and what it does.
export function RefTable({ head, rows }: RefTableProps) {
  return (
    <table className="w-full table-fixed border-collapse text-left text-[14px]">
      <thead>
        <tr className="border-b border-neutral-200">
          <th className="w-[46%] py-2 pr-4 font-bold text-neutral-600">{head[0]}</th>
          <th className="py-2 font-bold text-neutral-600">{head[1]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([code, text]) => (
          <tr key={code} className="border-b border-neutral-200 last:border-0 align-top">
            <td className="py-2 pr-4 [overflow-wrap:anywhere]">
              <code className="font-mono text-[12px] sm:text-[13px] text-neutral-800">{code}</code>
            </td>
            <td className="py-2 text-neutral-700">{text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
