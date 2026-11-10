import { lazy, Suspense } from 'react';
import { Navigate, Routes, Route, useLocation, useParams } from 'react-router-dom';
import LandingPageView from './views/LandingPageView';

// Graph views pull in react-force-graph; keep them out of the landing bundle
const ShareableGraphView = lazy(() => import('./views/ShareableGraphView'));
const DemoView = lazy(() => import('./views/DemoView'));
const SharedView = lazy(() => import('./views/SharedView'));
const AnalysesView = lazy(() => import('./views/AnalysesView'));
const PRView = lazy(() => import('./views/PRView'));
// Dev-only design-system catalog
const StyleGuideView = lazy(() => import('./views/StyleGuideView'));

/** Old share links (/graph/owner/repo) no longer start an analysis: open the landing page, repo prefilled. */
function RepoLinkRedirect() {
  const { owner, repo } = useParams();
  return <Navigate to={`/?repo=${encodeURIComponent(`${owner}/${repo}`)}`} replace />;
}

export default function App() {
  const location = useLocation();
  const showDevRoutes =
    import.meta.env.DEV || new URLSearchParams(location.search).get('dev') === '1';

  // Each view draws its own chrome (landing nav, app top bar), so there is no shared shell
  return (
    <Suspense fallback={<div className="h-dvh bg-cg-canvas" />}>
      <Routes>
        <Route path="/" element={<LandingPageView />} />
        <Route path="/demo" element={<DemoView />} />
        <Route path="/analyses" element={<AnalysesView />} />
        <Route path="/s/:token" element={<SharedView />} />
        <Route path="/graph/:owner/:repo" element={<RepoLinkRedirect />} />
        <Route path="/graph/:owner/:repo/jobs/:jobId" element={<ShareableGraphView />} />
        <Route path="/pr/:owner/:repo/:number/jobs/:jobId" element={<PRView />} />
        {showDevRoutes && <Route path="/dev/ui" element={<StyleGuideView />} />}
      </Routes>
    </Suspense>
  );
}
