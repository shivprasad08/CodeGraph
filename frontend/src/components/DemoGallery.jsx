import { useState } from "react"

const DEMOS = [
  {
    src: "/demo/First.png",
    title: "Interactive Knowledge Graph",
    caption: "395 nodes · 990 edges — pallets/flask rendered in full",
  },
  {
    src: "/demo/Second.png",
    title: "AI Node Summaries",
    caption: "Click any node for an LLM-generated plain-English explanation",
  },
  {
    src: "/demo/Third.png",
    title: "Syntax-Highlighted Code",
    caption: "Click any file to inspect source with clickable function names",
  },
  {
    src: "/demo/Forth.png",
    title: "Ask the Codebase",
    caption: "Chat with an AI that knows every function and dependency",
  },
  {
    src: "/demo/Fifth.png",
    title: "Health Score Dashboard",
    caption: "\"A–F grade, security findings, dead code, and pattern detection",
  },
  {
    src: "/demo/Sixth.png",
    title: "Ask the Codebase",
    caption: "Chat with an AI that knows every function and dependency",
  },
]

export default function DemoGallery() {
  return (
    <section className="w-full flex flex-col items-center justify-start py-24 bg-[#0a0a0f]">

      {/* Section heading */}
      <div className="max-w-2xl text-center px-4 mb-14">
        <p className="text-xs font-mono text-purple-400 uppercase tracking-widest mb-3">
          See it in action
        </p>
        <h2 className="text-4xl font-bold text-white tracking-tight">
          Everything you need to understand a codebase
        </h2>
        <p className="text-base text-white/40 mt-4 leading-relaxed">
          From the first graph render to a full AI-powered impact simulation —
          hover each panel to explore.
        </p>
      </div>

      {/* Gallery */}
      <div className="flex items-center gap-2 h-[460px] w-full max-w-6xl px-6">
        {DEMOS.map((demo, idx) => (
          <div
            key={idx}
            className="relative group flex-grow transition-all duration-500 
                       w-24 rounded-xl overflow-hidden h-[460px] 
                       hover:w-full cursor-pointer
                       border border-white/5 hover:border-purple-500/30"
            style={{ minWidth: "48px" }}
          >
            {/* Screenshot */}
            <img
              src={demo.src}
              alt={demo.title}
              className="h-full w-full object-cover object-top transition-all duration-500"
            />

            {/* Dark overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent transition-opacity duration-500" />

            {/* Vertical label — visible when collapsed */}
            <div className="absolute inset-0 flex items-center justify-center opacity-100 group-hover:opacity-0 transition-opacity duration-300">
              <span className="text-white/50 text-xs font-mono uppercase tracking-widest [writing-mode:vertical-rl] rotate-180 select-none">
                {demo.title}
              </span>
            </div>

            {/* Bottom caption — slides up on hover */}
            <div className="absolute bottom-0 left-0 right-0 p-5 translate-y-4 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-500">
              <p className="text-white font-semibold text-base leading-snug">
                {demo.title}
              </p>
              <p className="text-white/50 text-xs font-mono mt-1 leading-relaxed">
                {demo.caption}
              </p>
            </div>

            {/* Top-right index badge */}
            <div className="absolute top-3 right-3 w-6 h-6 rounded-full bg-purple-600/80 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              <span className="text-white text-xs font-mono font-bold">
                {idx + 1}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom stat strip */}
      <div className="mt-12 flex items-center gap-8 flex-wrap justify-center px-4">
        {[
          { value: "395", label: "nodes on pallets/flask" },
          { value: "990", label: "edges mapped" },
          { value: "60s", label: "avg full analysis" },
          { value: "100%", label: "free, no account needed" },
        ].map(s => (
          <div key={s.label} className="text-center">
            <div className="text-2xl font-bold text-white font-mono">
              {s.value}
            </div>
            <div className="text-xs text-white/30 mt-0.5 font-mono">
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
