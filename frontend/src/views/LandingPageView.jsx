import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { analyzeRepo } from '../api';

function extractRepoPath(url) {
  const match = url.match(/github\.com\/([^/]+\/[^/?#]+)/);
  return match ? match[1].replace(/\.git$/, "") : null;
}

export default function LandingPageView() {
  const [repoUrl, setRepoUrl] = useState('');
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!repoUrl.trim()) return;

    const path = extractRepoPath(repoUrl);
    if (!path) {
      setError("Please enter a valid GitHub repository URL (e.g., https://github.com/pallets/flask)");
      return;
    }

    const [owner, repo] = path.split('/');
    
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await analyzeRepo(repoUrl);
      navigate(`/graph/${owner}/${repo}/jobs/${result.job_id}`);
    } catch (err) {
      setError(err.message || 'Failed to start analysis');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white overflow-x-hidden font-sans">
      {/* Section 1 - Hero */}
      <section className="relative min-h-screen flex items-center justify-center pt-20 pb-32">
        <div 
          className="absolute inset-0 z-0 opacity-40 pointer-events-none"
          style={{
            backgroundImage: `
              linear-gradient(rgba(124,58,237,0.05) 1px, transparent 1px),
              linear-gradient(90deg, rgba(124,58,237,0.05) 1px, transparent 1px)
            `,
            backgroundSize: '40px 40px'
          }}
        />
        
        <div className="relative z-10 max-w-2xl mx-auto text-center px-4 w-full">
          <div className="text-xs font-mono text-[#7c3aed] uppercase tracking-widest mb-6 flex items-center justify-center">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#7c3aed] animate-pulse mr-2"></span>
            Open Source · Free · No signup
          </div>
          
          <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight leading-tight bg-gradient-to-br from-white via-white to-[#7c3aed]/60 bg-clip-text text-transparent">
            Understand any codebase in seconds
          </h1>
          
          <p className="text-lg text-[#94a3b8] mt-6 leading-relaxed max-w-xl mx-auto">
            Paste a GitHub URL. CodeGraph analyzes the repo with AI and renders every function, class, and dependency as an interactive knowledge graph.
          </p>
          
          <div className="mt-10 max-w-lg mx-auto">
            <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                placeholder="https://github.com/owner/repo"
                className="flex-1 bg-[#111118] border border-[#1e1e2e] rounded-lg px-4 py-3.5 text-white placeholder-[#94a3b8] focus:outline-none focus:border-[#7c3aed] transition"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                disabled={isSubmitting}
              />
              <button
                type="submit"
                disabled={isSubmitting || !repoUrl.trim()}
                className="bg-[#7c3aed] hover:bg-[#6d28d9] text-white px-8 py-3.5 rounded-lg font-medium transition disabled:opacity-50 flex items-center justify-center min-w-[140px]"
              >
                {isSubmitting ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                ) : (
                  'Analyze Repo'
                )}
              </button>
            </form>
            {error && (
              <p className="mt-3 text-red-400 text-sm text-center bg-red-400/10 py-2 px-3 rounded-md border border-red-400/20">
                {error}
              </p>
            )}
          </div>

          <div className="mt-8 flex items-center justify-center gap-4 text-sm text-[#94a3b8]">
            <span>Try these:</span>
            <button 
              onClick={() => setRepoUrl('https://github.com/pallets/flask')}
              className="hover:text-[#7c3aed] transition underline underline-offset-4"
            >
              pallets/flask
            </button>
            <button 
              onClick={() => setRepoUrl('https://github.com/encode/starlette')}
              className="hover:text-[#7c3aed] transition underline underline-offset-4"
            >
              encode/starlette
            </button>
          </div>
        </div>

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 text-xs text-[#94a3b8] font-mono animate-bounce">
          ↓ See how it works
        </div>
      </section>

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
