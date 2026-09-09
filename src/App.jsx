// No AuthProvider, ProtectedRoute, or auth routes: COGNOS opens directly to chat.
import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import CognosLayout from '@/components/CognosLayout';
import { VoiceProvider } from '@/lib/voiceContext';

// Pages are split at route boundaries. The System console is intentionally
// substantial; loading it only when visited keeps the core chat bundle lean.
const Chat = lazy(() => import('@/pages/Chat'));
const Memory = lazy(() => import('@/pages/Memory'));
const Activity = lazy(() => import('@/pages/Activity'));
const System = lazy(() => import('@/pages/System'));
const Identity = lazy(() => import('@/pages/Identity'));
const Settings = lazy(() => import('@/pages/Settings'));
const Projects = lazy(() => import('@/pages/Projects'));
const Autonomy = lazy(() => import('@/pages/Autonomy'));

function PageFallback() {
  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="w-7 h-7 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export default function App() {
  return (
    <VoiceProvider>
      <Router>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route element={<CognosLayout />}>
              <Route path="/" element={<Chat />} />
              <Route path="/memory" element={<Memory />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/autonomy" element={<Autonomy />} />
              <Route path="/system" element={<System />} />
              <Route path="/about" element={<Identity />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Router>
    </VoiceProvider>
  );
}
