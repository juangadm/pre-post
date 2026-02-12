import { ImageResponse } from 'next/og'

export const size = {
  width: 32,
  height: 32,
}
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="32" height="32" viewBox="9.3 -3.03 81.4 81.4">
          {/* Outlined triangle */}
          <polygon
            points="50,3.33 85.9,73.33 14.1,73.33"
            fill="none"
            stroke="#000000"
            strokeWidth="2.2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* Right half filled */}
          <polygon
            points="50,5.74 84.1,72.23 50,72.23"
            fill="#000000"
            stroke="#000000"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    {
      ...size,
    }
  )
}
