export function LobsterMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 44"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 17c-1.9-2.2-2.3-5.2-1.3-8M23 17c1.9-2.2 2.3-5.2 1.3-8" />
        <path d="M14.5 19c-3.4-1.3-5.2-3.5-5.9-6.4M25.5 19c3.4-1.3 5.2-3.5 5.9-6.4" />
        <path d="M8.6 13C4 11.4 3.4 7.7 5.6 4.2l2.2 3.1L11 3.2c2.2 4.9 1.3 8-2.4 9.8ZM31.4 13c4.6-1.6 5.2-5.3 3-8.8l-2.2 3.1L29 3.2c-2.2 4.9-1.3 8 2.4 9.8Z" />
        <path d="M20 15c4.2 0 6.3 3.8 5.5 8.3L23 35h-6l-2.5-11.7C13.7 18.8 15.8 15 20 15Z" />
        <path d="m15.2 23.5-5.3 1.7-2 3.4m8.4-.4L12.2 30 11 33m13.8-9.5 5.3 1.7 2 3.4m-8.4-.4 4.1 1.8 1.2 3M16.4 25h7.2M17.4 30h5.2" />
        <path d="m17 35-3 4.5c2 .9 4.1 1.3 6 1.3s4-.4 6-1.3L23 35m-3 1v4" />
      </g>
      <circle cx="18.1" cy="18.2" r=".8" fill="currentColor" />
      <circle cx="21.9" cy="18.2" r=".8" fill="currentColor" />
    </svg>
  );
}

export function RollIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 340 224" fill="none" className={className} aria-hidden="true">
      <ellipse cx="176" cy="184" rx="133" ry="23" fill="#dce6dc" opacity=".62" />
      <path
        d="M44 168c5 22 58 38 126 38s123-13 132-36c-37-13-213-15-258-2Z"
        fill="#fafaf3"
        stroke="#99afa0"
        strokeWidth="1.4"
      />
      <path
        d="M67 178c26 12 68 19 107 18 42 0 81-6 106-17"
        stroke="#bccabd"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <g transform="rotate(-8 170 132)">
        <path
          d="M66 107c-1-22 13-37 37-39l136 3c19 1 32 15 30 35l-8 49-181-1-14-47Z"
          fill="#e8ba73"
          stroke="#a56e3c"
          strokeWidth="1.8"
        />
        <path
          d="M85 85c9-7 17-8 25-7l122 3c11 0 20 6 24 13"
          stroke="#f6d89a"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M77 117c16-25 44-29 68-27l74 3c20-1 38 9 44 24l-7 44-166-2-13-42Z"
          fill="#a86638"
        />
        <path
          d="m80 114 13-16 11 7 12-12 16 10 14-10 11 8 12-8 12 11 17-9 9 9 16-3 12 8 15-5 13 13-13 17-156 6-16-26Z"
          fill="#637e50"
          stroke="#476447"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M95 108c-8-12 3-25 13-24 5-14 26-10 29 3 9-4 17 3 16 14l-17 22-32 1-9-16Z"
          fill="#faf0d6"
          stroke="#c2644f"
          strokeWidth="1.4"
        />
        <path
          d="M100 103c-3-7 2-14 8-15m1-1c6-6 15-3 18 3m-22 20 5-7 9 2 7-8"
          stroke="#d8755e"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M140 105c-4-12 7-20 18-18 1-11 15-16 24-9 7-3 16 3 16 12 16-2 25 8 22 21l-32 21-41-10-7-17Z"
          fill="#fff3d8"
          stroke="#c2644f"
          strokeWidth="1.4"
        />
        <path
          d="M148 103c0-6 5-10 12-9l4-10c4-4 10-5 15-1m0 13 12-3 8 7 11 1m-43 11 7-5"
          stroke="#d8755e"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M216 106c-5-9 2-20 13-19 4-9 17-8 22 1 12 0 16 16 6 24l-25 15-16-21Z"
          fill="#faedd0"
          stroke="#c2644f"
          strokeWidth="1.4"
        />
        <path
          d="M225 102c-3-5 1-10 7-9l6-5 9 5m-8 17 13-8"
          stroke="#d8755e"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M79 120c2-10 11-13 20-7 16 11 31 11 50 9l79 2c15 0 25-2 35-11 9-7 18-2 17 10l-9 35c-3 15-17 23-32 24l-134-6c-13-1-20-8-22-21l-4-35Z"
          fill="#e8bc76"
          stroke="#a56e3c"
          strokeWidth="1.8"
        />
        <path
          d="M91 129c6 13 11 29 22 35l122 6c14-1 23-7 28-17"
          stroke="#f4d99c"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="m105 145 2 4m13 4 3 2m-11-20 2 2m32 21 4 1m15-19 3 1m15 17 4 1m25-14 3-1m24 5 3-3m-9-10 2-1"
          stroke="#b88345"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path
          d="m127 102 9-5m24 19 2-6m35-22 7-2m28 23 5 2m-50-5 5 3m-76 6 2-6"
          stroke="#466a49"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </g>
      <path
        d="M268 174c4-11 13-17 24-17 1 12-4 24-13 30l-11-13Z"
        fill="#ead79b"
        stroke="#999452"
        strokeWidth="1.3"
      />
      <path
        d="m272 174 16-13m-14 15 14-6m-12 9 10-2"
        stroke="#f9f3d4"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="m65 183 12-3m-5 7 9-7" stroke="#658260" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
