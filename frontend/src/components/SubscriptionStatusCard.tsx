import React, { useState, useEffect } from 'react';
import { Shield, Clock, Hash, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { authFetch, API } from '../utils/api';

const DURATION_LABELS: Record<string, string> = {
  day: 'يوم واحد',
  month: 'شهر واحد',
  '2months': 'شهران',
  '3months': '3 أشهر',
  year: 'سنة كاملة',
};

export default function SubscriptionStatusCard() {
  const [sub, setSub]         = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch(`${API}/subscription/me`)
      .then(r => r.json())
      .then(d => { if (d.success) setSub(d.subscription); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 animate-pulse h-28" />
    );
  }

  if (!sub) return null;

  const isExpired = sub.isExpired;
  const isActive  = !isExpired && sub.status === 'active';
  const pct       = sub.maxAccounts ? Math.min(100, Math.round((sub.usedAccounts / sub.maxAccounts) * 100)) : 0;

  return (
    <div className={`bg-[var(--bg-surface)] border rounded-2xl p-4 space-y-3 ${
      isExpired ? 'border-red-500/40' : isActive ? 'border-[var(--border-default)]' : 'border-amber-500/40'
    }`} dir="rtl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className={`w-4 h-4 ${isExpired ? 'text-red-400' : 'text-[var(--brand-primary)]'}`} />
          <span className="text-sm font-semibold text-[var(--text-primary)]">الاشتراك</span>
        </div>
        {isExpired ? (
          <span className="flex items-center gap-1 text-xs font-medium text-red-400">
            <AlertTriangle className="w-3 h-3" /> منتهي
          </span>
        ) : isActive ? (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-400">
            <CheckCircle className="w-3 h-3" /> فعّال
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs font-medium text-amber-400">
            <XCircle className="w-3 h-3" /> موقوف
          </span>
        )}
      </div>

      {isExpired && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/25 px-3 py-2 text-xs text-red-300 text-center">
          انتهى اشتراكك. تواصل مع المدير للتجديد.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
          <Clock className="w-3 h-3 flex-shrink-0" />
          <span>
            {DURATION_LABELS[sub.duration] || sub.duration}
            {sub.daysRemaining !== null && !isExpired && (
              <span className={`mr-1 ${sub.daysRemaining <= 3 ? 'text-amber-400 font-medium' : ''}`}>
                ({sub.daysRemaining} يوم)
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
          <Hash className="w-3 h-3 flex-shrink-0" />
          <span>
            {sub.usedAccounts} / {sub.isUnlimited ? '∞' : sub.maxAccounts} حساب
          </span>
        </div>
      </div>

      {!sub.isUnlimited && sub.maxAccounts > 0 && (
        <div>
          <div className="h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-[var(--brand-primary)]'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {sub.remainingAccounts === 0 && (
            <p className="text-xs text-amber-400 mt-1">لقد وصلت إلى الحد الأقصى من الحسابات.</p>
          )}
        </div>
      )}
    </div>
  );
}
