import { lazy, Suspense } from 'react';
import { Routes, Route, Link, useLocation } from 'react-router-dom';
import LandingPageView from './views/LandingPageView';
import ShareableGraphView from './views/ShareableGraphView';

// Dev-only design-system catalog; lazy so it is not in the main bundle
const StyleGuideView = lazy(() => import('./views/StyleGuideView'));

export default function App() {
  const location = useLocation();
  const showDevRoutes =
    import.meta.env.DEV || new URLSearchParams(location.search).get('dev') === '1';

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white font-sans flex flex-col">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 h-14 bg-[#111118]/80 backdrop-blur border-b border-[#1e1e2e] z-50 flex items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2 font-mono font-medium text-white hover:opacity-80 transition">
          <span>🕸️</span>
          <span>CodeGraph</span>
        </Link>
        <a 
          href="https://github.com/shivprasad08/CodeGraph" 
          target="_blank" 
          rel="noreferrer"
          className="text-[#94a3b8] hover:text-white transition text-sm"
        >
          GitHub
        </a>
      </header>

      {/* Main Content Area */}
      <main className="mt-14 flex-1 relative flex flex-col">
        <Routes>
          <Route path="/" element={<LandingPageView />} />
          <Route path="/graph/:owner/:repo" element={<ShareableGraphView />} />
          <Route path="/graph/:owner/:repo/jobs/:jobId" element={<ShareableGraphView />} />
          {showDevRoutes && (
            <Route
              path="/dev/ui"
              element={
                <Suspense fallback={null}>
                  <StyleGuideView />
                </Suspense>
              }
            />
          )}
        </Routes>
      </main>
    </div>
  );
}
