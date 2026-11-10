import React, { useState } from "react";
import { createRoot } from "react-dom/client";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <main style={{ fontFamily: "system-ui", padding: "3rem", background: "#0a0a0f", color: "#f4f4f6", minHeight: "100vh" }}>
      <h1 style={{ color: "#38bdf8" }}>⚡ AadiJS + React</h1>
      <p>Fast Refresh & instant bundling powered by Bun.</p>
      <button onClick={() => setCount((c) => c + 1)} style={{ padding: "0.6rem 1.2rem", fontSize: "1rem", cursor: "pointer" }}>
        Count: {count}
      </button>
    </main>
  );
}

if (typeof document !== "undefined") {
  const el = document.getElementById("root");
  if (el) createRoot(el).render(<Counter />);
}
