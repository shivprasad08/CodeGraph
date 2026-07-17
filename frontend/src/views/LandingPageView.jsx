import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { analyzeRepo } from '../api';
import Hero from '../components/Hero';
import DemoGallery from '../components/DemoGallery';

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

      {/* Section 2 - Demo Gallery */}
      <DemoGallery />

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
