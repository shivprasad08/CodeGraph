import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { analyzeRepo } from '../api';
import Hero from '../components/Hero';

function extractRepoPath(url) {
  const match = url.match(/github\.com\/([^/]+\/[^/?#]+)/);
  return match ? match[1].replace(/\.git$/, "") : null;
}

export default function LandingPageView() {
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const handleAnalyze = async (url) => {
    const path = extractRepoPath(url);
    if (!path) {
      setError("Please enter a valid GitHub repository URL (e.g., https://github.com/pallets/flask)");
      return;
    }

    const [owner, repo] = path.split('/');
    
    setError(null);
    try {
      const result = await analyzeRepo(url);
      navigate(`/graph/${owner}/${repo}/jobs/${result.job_id}`);
    } catch (err) {
      setError(err.message || 'Failed to start analysis');
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white overflow-x-hidden font-sans">
      {/* Section 1 - Hero with interactive particle canvas */}
      <Hero onAnalyze={handleAnalyze} />

      {/* Section 2 - How it works */}
      <section className="py-24 max-w-4xl mx-auto px-4">
        <h2 className="text-3xl font-semibold text-center mb-16 text-white">How it works</h2>
        
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 relative">
          <div className="hidden sm:block absolute top-1/2 left-[30%] text-[#1e1e2e] text-xl transform -translate-y-1/2 z-0">→</div>
          <div className="hidden sm:block absolute top-1/2 right-[30%] text-[#1e1e2e] text-xl transform -translate-y-1/2 z-0">→</div>

          {[
            { step: 1, icon: '🔗', title: 'Paste a repo URL', desc: 'Any public GitHub repository. Python projects work best right now.' },
            { step: 2, icon: '🔬', title: 'AI analyzes the code', desc: 'tree-sitter parses every function and class. Groq AI writes a plain-English summary for each one.' },
            { step: 3, icon: '🕸️', title: 'Explore the graph', desc: 'Click any node to see what it does, what calls it, and what it calls. Share the URL with your team.' }
          ].map((item) => (
            <div key={item.step} className="bg-[#111118] border border-[#1e1e2e] rounded-xl p-6 relative z-10 shadow-xl">
              <div className="absolute -top-3 -left-3 w-7 h-7 rounded-full bg-[#7c3aed] font-mono font-bold text-sm text-white flex items-center justify-center">
                {item.step}
              </div>
              <div className="text-4xl mb-4 text-center">{item.icon}</div>
              <h3 className="text-white font-semibold text-lg mb-2 text-center">{item.title}</h3>
              <p className="text-[#94a3b8] text-sm leading-relaxed text-center">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Section 3 - Tech stack transparency */}
      <section className="py-20 bg-[#111118]/30 border-y border-[#1e1e2e]">
        <div className="max-w-4xl mx-auto px-4 text-center">
          <h2 className="text-2xl font-semibold mb-2 text-white">Built with</h2>
          <p className="text-[#94a3b8] text-sm mb-12">Entirely open source. All free-tier APIs.</p>
          
          <div className="flex flex-wrap justify-center items-center gap-4">
            {[
              { label: 'FastAPI', icon: '🐍' },
              { label: 'tree-sitter', icon: '🌳' },
              { label: 'Groq (llama-3.3-70b)', icon: '⚡' },
              { label: 'Mistral AI', icon: '🤖' },
              { label: 'React + Vite', icon: '⚛️' },
              { label: 'react-force-graph', icon: '🕸️' },
            ].map(tech => (
              <div key={tech.label} className="bg-[#111118] border border-[#1e1e2e] rounded-full px-4 py-2 font-mono text-sm text-white/80 flex items-center gap-2 shadow-sm">
                <span>{tech.icon}</span> {tech.label}
              </div>
            ))}
          </div>
          
          <div className="mt-12">
            <a 
              href="https://github.com/shivprasad08/CodeGraph" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-[#7c3aed] hover:text-[#9355ef] font-mono text-sm underline-offset-4 hover:underline transition"
            >
              View source on GitHub →
            </a>
          </div>
        </div>
      </section>

      {/* Section 4 - Footer */}
      <footer className="py-8 border-t border-[#1e1e2e]">
        <div className="max-w-4xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="font-mono text-[#94a3b8] text-sm">CodeGraph</div>
          <div className="flex items-center gap-4">
            <span className="text-[#94a3b8] text-sm">Made by Shivprasad Mahind</span>
            <a href="https://shivprasadportfolio.vercel.app" target="_blank" rel="noopener noreferrer" className="text-[#7c3aed] hover:text-[#9355ef] text-sm">Portfolio</a>
            <a href="https://github.com/shivprasad08" target="_blank" rel="noopener noreferrer" className="text-[#7c3aed] hover:text-[#9355ef] text-sm">GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
