import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './components/ui/ToastProvider';
import LoginPage from './components/LoginPage';
import { AppLayout } from './components/layout/AppLayout';

// Views
import DashboardHome        from './views/DashboardHome';
import AccountsView         from './views/AccountsView';
import CampaignsView        from './views/CampaignsView';
import GroupsView           from './views/GroupsView';
import LinkDashboardView    from './views/LinkDashboardView';
import ScheduleDashboardView from './views/ScheduleDashboardView';
import AdLibraryView        from './views/AdLibraryView';
import DirectPublishView    from './views/DirectPublishView';
// Admin views
import UsersView            from './views/UsersView';
import SubscriptionsView    from './views/SubscriptionsView';
import LicensesView         from './views/LicensesView';
import AdminStatsView       from './views/AdminStatsView';

import { ErrorBoundary } from './components/ErrorBoundary';
import {
  API, TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY,
  saveTokens, clearTokens, authFetch,
} from './utils/api';


function ProtectedRoute({ children, adminOnly = false, currentUser }:
  { children: React.ReactNode; adminOnly?: boolean; currentUser: any }) {
  if (adminOnly && !['super_admin', 'admin'].includes(currentUser?.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function AppInner() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [currentUser, setCurrentUser] = useState<any>(() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  });
  const [isConnected, setIsConnected] = useState(true);

  // ── Account state lifted here to satisfy AppLayout + AccountsView ──────────
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  // ── FIX 1: Race condition — cancel stale verify fetches with cleanup flag ──
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    fetch(`${API}/auth/verify`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;                       // ← stale response, ignore
        if (!d.success) { handleLogout(); return; }
        const merged = { ...currentUser, ...d.user };
        setCurrentUser(merged);
        localStorage.setItem(USER_KEY, JSON.stringify(merged));
      })
      .catch(() => { if (!cancelled) setIsConnected(false); });

    return () => { cancelled = true; };             // ← cancel on next render
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── FIX 2: Fetch accounts so AppLayout/TopBar get the data they need ───────
  const fetchAccounts = useCallback(async () => {
    if (!token) return;
    setAccountsLoading(true);
    try {
      const res  = await authFetch(`${API}/accounts`);
      const data = await res.json();
      if (data.success) {
        const list: any[] = data.accounts ?? [];
        setAccounts(list);
        // Auto-select first account if none chosen yet
        setSelectedAccountId(prev => prev ?? (list.length > 0 ? list[0].id : null));
      }
    } catch {
      // network error — silent
    } finally {
      setAccountsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token && currentUser) fetchAccounts();
  }, [token, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleLogin(accessToken: string, refreshToken: string, user: any) {
    saveTokens(accessToken, refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    setToken(accessToken);
    setCurrentUser(user);
  }

  function handleLogout() {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (token) {
      fetch(`${API}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {});
    }
    clearTokens();
    setToken(null);
    setCurrentUser(null);
    setAccounts([]);
    setSelectedAccountId(null);
  }

  if (!token || !currentUser) {
    return <LoginPage onLogin={handleLogin} />;
  }

  /* Subscription expired for regular users */
  const isExpired =
    currentUser.subscriptionStatus === 'expired' &&
    !['super_admin', 'admin'].includes(currentUser.role);

  if (isExpired) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-app)]">
        <div className="text-center max-w-md p-8 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-3xl">
          <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">⚠️</span>
          </div>
          <h2 className="text-xl font-bold mb-2">انتهى اشتراكك</h2>
          <p className="text-[var(--text-muted)] mb-6 text-sm">يرجى التواصل مع المسؤول لتجديد اشتراكك والمتابعة.</p>
          <button
            onClick={handleLogout}
            className="px-6 py-2.5 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all"
          >
            تسجيل الخروج
          </button>
        </div>
      </div>
    );
  }

  return (
    // FIX 2: All required AppLayout props now provided
    <AppLayout
      currentUser={currentUser}
      onLogout={handleLogout}
      accounts={accounts}
      selectedAccountId={selectedAccountId}
      onAccountChange={setSelectedAccountId}
    >
      <ErrorBoundary>
        <Routes>
          {/* FIX 3: accounts prop passed to DashboardHome */}
          <Route path="/"               element={<DashboardHome accounts={accounts} />} />
          <Route path="/accounts"       element={
            <AccountsView
              accounts={accounts}
              loading={accountsLoading}
              fetchAccounts={fetchAccounts}
              selectedAccountId={selectedAccountId}
              setSelectedAccountId={setSelectedAccountId}
            />
          } />
          <Route path="/campaigns"      element={<CampaignsView      accountId={selectedAccountId} />} />
          <Route path="/groups"         element={<GroupsView          accountId={selectedAccountId} />} />
          <Route path="/links"          element={<LinkDashboardView    accountId={selectedAccountId} />} />
          <Route path="/schedules"      element={<ScheduleDashboardView accountId={selectedAccountId} />} />
          <Route path="/ad-library"     element={<AdLibraryView        accountId={selectedAccountId} />} />
          <Route path="/direct-publish" element={<DirectPublishView    accountId={selectedAccountId} accounts={accounts} />} />

          {/* Admin-only routes */}
          <Route path="/admin/stats"   element={
            <ProtectedRoute adminOnly currentUser={currentUser}>
              <AdminStatsView />
            </ProtectedRoute>} />
          <Route path="/admin/users"   element={
            <ProtectedRoute adminOnly currentUser={currentUser}>
              <UsersView />
            </ProtectedRoute>} />
          <Route path="/admin/subscriptions" element={
            <ProtectedRoute adminOnly currentUser={currentUser}>
              <SubscriptionsView />
            </ProtectedRoute>} />
          <Route path="/admin/licenses" element={
            <ProtectedRoute adminOnly currentUser={currentUser}>
              <LicensesView />
            </ProtectedRoute>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </AppLayout>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <AppInner />
      </BrowserRouter>
    </ToastProvider>
  );
}
