import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

interface AppLayoutProps {
  children: React.ReactNode;
  accounts: any[];
  selectedAccountId: string | null;
  onAccountChange: (id: string | null) => void;
  currentUser: any;
  onLogout: () => void;
}

export function AppLayout({
  children,
  accounts,
  selectedAccountId,
  onAccountChange,
  currentUser,
  onLogout
}: AppLayoutProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const isConnected = selectedAccount?.status === 'connected';

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      {/* Sidebar - RTL so it's on the right */}
      <Sidebar 
        isCollapsed={isCollapsed} 
        setIsCollapsed={setIsCollapsed}
        currentUser={currentUser}
        onLogout={onLogout}
        isConnected={isConnected}
      />
      
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar 
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onAccountChange={onAccountChange}
          currentUser={currentUser}
        />
        <main className="flex-1 overflow-y-auto p-6 scroll-smooth">
          <div className="max-w-7xl mx-auto w-full" style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
