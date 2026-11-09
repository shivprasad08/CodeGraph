import { lazy, Suspense } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import LandingPageView from './views/LandingPageView';

// Graph views pull in react-force-graph; keep them out of the landing bundle
const ShareableGraphView = lazy(() => import('./views/ShareableGraphView'));
const DemoView = lazy(() => import('./views/DemoView'));
// Dev-only design-system catalog
const StyleGuideView = lazy(() => import('./views/StyleGuideView'));

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
        <Route path="/graph/:owner/:repo" element={<ShareableGraphView />} />
        <Route path="/graph/:owner/:repo/jobs/:jobId" element={<ShareableGraphView />} />
        {showDevRoutes && <Route path="/dev/ui" element={<StyleGuideView />} />}
      </Routes>
    </Suspense>
  );
}
