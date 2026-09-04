// No AuthProvider, no ProtectedRoute, no login/register/forgot/reset routes,
// no OAuth consent. The app opens straight to chat.
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import CognosLayout from '@/components/CognosLayout';
import Chat from '@/pages/Chat';
import Memory from '@/pages/Memory';
import Activity from '@/pages/Activity';
import Settings from '@/pages/Settings';

export default function App() {
  return (
    <Router>
      <Routes>
        <Route element={<CognosLayout />}>
          <Route path="/" element={<Chat />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}
