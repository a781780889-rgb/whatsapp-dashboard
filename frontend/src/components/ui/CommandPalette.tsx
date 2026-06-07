import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Search, LayoutDashboard, Users, Library, Send, Calendar, Megaphone, Link as LinkIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const items = [
    { id: 'dashboard', name: 'لوحة التحكم', icon: LayoutDashboard, path: '/' },
    { id: 'accounts', name: 'الحسابات', icon: Users, path: '/accounts' },
    { id: 'ad-library', name: 'مكتبة الإعلانات', icon: Library, path: '/ad-library' },
    { id: 'direct-publish', name: 'النشر المباشر', icon: Send, path: '/direct-publish' },
    { id: 'schedules', name: 'النشر المجدول', icon: Calendar, path: '/schedules' },
    { id: 'campaigns', name: 'الحملات', icon: Megaphone, path: '/campaigns' },
    { id: 'links', name: 'مراقبة الروابط', icon: LinkIcon, path: '/links' },
  ];

  const filteredItems = items.filter(item => 
    item.name.toLowerCase().includes(query.toLowerCase())
  );

  const handleSelect = (path: string) => {
    navigate(path);
    setOpen(false);
    setQuery('');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="p-0 max-w-2xl bg-[var(--bg-surface)] border-[var(--border-strong)] shadow-elevated gap-0 overflow-hidden">
        <div className="flex items-center px-4 py-3 border-b border-[var(--border-default)]">
          <Search className="w-5 h-5 text-[var(--text-muted)] ml-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent border-none outline-none text-base text-[var(--text-primary)] placeholder:text-[var(--text-muted)] h-10"
            placeholder="إلى أين تريد الذهاب؟..."
          />
          <kbd className="px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded text-xs text-[var(--text-muted)] font-mono">
            ESC
          </kbd>
        </div>
        
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {filteredItems.length === 0 ? (
            <div className="py-14 text-center text-[var(--text-muted)] text-sm">
              لا توجد نتائج مطابقة لبحثك.
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="px-2 py-1.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                الصفحات
              </div>
              {filteredItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item.path)}
                  className="flex items-center w-full gap-3 px-3 py-3 rounded-xl hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors group text-right"
                >
                  <div className="w-8 h-8 rounded-lg bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center group-hover:border-[var(--border-strong)] group-hover:text-[var(--brand-primary)] transition-colors">
                    <item.icon className="w-4 h-4" />
                  </div>
                  <span className="flex-1 font-medium">{item.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
