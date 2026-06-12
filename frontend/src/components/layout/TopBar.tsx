import React, { useEffect, useState } from 'react';
import { Search, Bell, Sun, Moon, ChevronDown, Check } from 'lucide-react';
import { cn } from '@/utils/cn';

interface TopBarProps {
  accounts: any[];
  selectedAccountId: string | null;
  onAccountChange: (id: string | null) => void;
  currentUser: any;
}

export function TopBar({ accounts, selectedAccountId, onAccountChange, currentUser }: TopBarProps) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [showAccounts, setShowAccounts] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const selectedAccount = accounts.find(a => a.id === selectedAccountId);

  return (
    <header className="h-16 flex items-center justify-between px-6 border-b border-[var(--border-default)] bg-[var(--bg-surface)]/80 backdrop-blur-md z-10 sticky top-0">
      
      {/* Search / Command Palette trigger */}
      <div className="flex-1 flex items-center">
        <button 
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-all w-64 text-sm"
          onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}
        >
          <Search className="w-4 h-4" />
          <span>بحث سريع...</span>
          <div className="mr-auto flex gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-app)] text-[10px] font-mono border border-[var(--border-strong)]">Ctrl</kbd>
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-app)] text-[10px] font-mono border border-[var(--border-strong)]">K</kbd>
          </div>
        </button>
      </div>

      {/* Right side actions */}
      <div className="flex items-center gap-4">
        
        {/* Account Selector */}
        <div className="relative">
          <button 
            onClick={() => setShowAccounts(!showAccounts)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] hover:bg-[var(--border-default)] transition-colors text-sm font-medium min-w-[160px]"
          >
            <div className={cn("w-2 h-2 rounded-full", selectedAccount?.status === 'connected' ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" : "bg-red-500")} />
            <span className="truncate flex-1 text-right">{selectedAccount?.name || 'اختر حساباً'}</span>
            <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
          </button>

          {showAccounts && (
            <div className="absolute top-full mt-1 left-0 w-full min-w-[200px] bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl shadow-elevated overflow-hidden z-50 animate-scale-in origin-top-left">
              <div className="max-h-64 overflow-y-auto p-1">
                {accounts.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-[var(--text-muted)] text-center">لا توجد حسابات</div>
                ) : (
                  accounts.map(acc => (
                    <button
                      key={acc.id}
                      onClick={() => { onAccountChange(acc.id); setShowAccounts(false); }}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors text-sm text-right"
                    >
                      <div className={cn("w-2 h-2 rounded-full", acc.status === 'connected' ? "bg-green-500" : "bg-red-500")} />
                      <span className="flex-1 truncate">{acc.name}</span>
                      {selectedAccountId === acc.id && <Check className="w-4 h-4 text-[var(--brand-primary)]" />}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="w-px h-6 bg-[var(--border-default)]" />

        {/* Theme Toggle */}
        <button 
          onClick={toggleTheme}
          className="p-2 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
          title="تبديل المظهر"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>

        {/* Notifications */}
        <button className="p-2 rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors relative">
          <Bell className="w-5 h-5" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border border-[var(--bg-surface)]" />
        </button>

      </div>
    </header>
  );
}
