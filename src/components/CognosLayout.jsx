// Ported from the original src/components/CognosLayout.jsx.
// DIVERGENCE: no base44.auth.me(), no currentUser, no member_ids. There are no
// accounts, so the layout just resolves the single default workspace from the
// app's own API. The drawer/sidebar/mobile-nav structure is preserved.

import { useState, useEffect, useCallback } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { api } from '@/lib/api';
import { CognosContext } from '@/lib/cognosContext';
import Sidebar from '@/components/chat/Sidebar';
import MobileNav from '@/components/chat/MobileNav';
import { useDialogFocus } from '@/components/ui/CognosUi';

export default function CognosLayout() {
  const [activeWorkspace, setActiveWorkspace] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [projects, setProjects] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [bootError, setBootError] = useState(null);
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const sidebarPanelRef = useDialogFocus(isSidebarOpen, closeSidebar);

  // Auto-close the mobile sidebar drawer on any navigation, so it never gets
  // stuck open after tapping a menu item.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    (async () => {
      try {
        setActiveWorkspace(await api.getWorkspace());
      } catch (e) {
        setBootError(e.message || 'Failed to initialize workspace');
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!activeWorkspace) return;
    try {
      setConversations(await api.listConversations());
    } catch (e) {
      console.error('Failed to load conversations:', e);
    }
  }, [activeWorkspace]);

  // Phase 18 — durable research projects ride alongside the conversation list.
  const refreshProjects = useCallback(async () => {
    if (!activeWorkspace) return;
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      console.error('Failed to load projects:', e);
    }
  }, [activeWorkspace]);

  useEffect(() => { refreshProjects(); }, [refreshProjects]);

  const projectById = useCallback((projectId) => projects.find(p => p.id === projectId) || null,
    [projects]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-background px-6 text-center">
        <h1 className="text-lg font-semibold mb-2">COGNOS cannot reach its database</h1>
        <p className="text-sm text-muted-foreground max-w-md">{bootError}</p>
        <p className="text-xs text-muted-foreground mt-4 max-w-md">
          Set <code className="bg-muted px-1 rounded">DATABASE_URL</code> to the pooled
          <code className="bg-muted px-1 rounded ml-1">postgres://</code> connection string and restart.
        </p>
      </div>
    );
  }

  return (
    <CognosContext.Provider value={{
      activeWorkspace, setActiveWorkspace,
      conversations, refreshConversations,
      projects, refreshProjects, projectById,
      activeConversationId, setActiveConversationId,
      openSidebar,
      closeSidebar
    }}>
      <div className="flex h-[100dvh] bg-background text-foreground overflow-hidden">
        <div className="hidden md:flex w-[280px] flex-col border-r border-border bg-card/30">
          <Sidebar />
        </div>

        {isSidebarOpen && (
          <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeSidebar} />
            <div ref={sidebarPanelRef} tabIndex={-1} className="absolute left-0 top-0 bottom-0 w-[280px] bg-card border-r border-border animate-fade-in" style={{ paddingTop: 'env(safe-area-inset-top, 12px)' }}>
              <Sidebar onNavigate={closeSidebar} />
            </div>
          </div>
        )}

        <main className="flex-1 flex flex-col overflow-hidden pb-[calc(env(safe-area-inset-bottom,12px)+64px)] md:pb-0">
          <AnimatePresence mode="wait" initial={!reduceMotion}>
            <motion.div
              key={location.pathname}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
              className="flex-1 flex flex-col min-h-0"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <MobileNav />
    </CognosContext.Provider>
  );
}
