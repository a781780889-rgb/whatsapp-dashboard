import React, { useState, useEffect } from 'react';
import { Users, CreditCard, Shield, Activity, TrendingUp, AlertTriangle, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import { API, authFetch } from '../utils/api';

interface Stats { users:{total:number;active:number;suspended:number;expired:number}; subscriptions:{trial:number;lifetime:number;planBreakdown:any[]}; accounts:{total:number;active:number}; security:{failedLogins24h:number}; recentActivity:any[]; userGrowth:any[]; }

function StatCard({ icon:Icon, label, value, sub, color='var(--brand-primary)' }:{ icon:any; label:string; value:number|string; sub?:string; color?:string }) {
  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5 flex items-start gap-4 hover:border-[var(--border-strong)] transition-colors">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{background:`${color}18`}}>
        <Icon className="w-5 h-5" style={{color}}/>
      </div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-sm font-medium text-[var(--text-secondary)] mt-0.5">{label}</p>
        {sub && <p className="text-xs text-[var(--text-muted)] mt-1">{sub}</p>}
      </div>
    </div>
  );
}

const ACTION_LABELS:Record<string,string> = {
  LOGIN_SUCCESS:'تسجيل دخول', LOGIN_FAILED:'محاولة فاشلة', LOGOUT:'خروج',
  USER_CREATED:'مستخدم جديد', USER_DELETED:'حذف مستخدم',
  USER_SUSPENDED:'إيقاف مستخدم', USER_ACTIVATED:'تفعيل مستخدم',
  SUBSCRIPTION_CREATED:'اشتراك جديد', LICENSE_ISSUED:'ترخيص جديد',
  CHANGE_PASSWORD:'تغيير كلمة المرور'
};

export default function AdminStatsView() {
  const [stats, setStats] = useState<Stats|null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res  = await authFetch(`${API}/admin/stats`);
      const data = await res.json();
      if (data.success) setStats(data.stats);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  if (loading) return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-pulse">
      {Array.from({length:8}).map((_,i)=>(
        <div key={i} className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5 h-24"/>
      ))}
    </div>
  );

  if (!stats) return null;

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">إحصائيات النظام</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">نظرة شاملة على المنصة</p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-colors text-sm">
          <RefreshCw className={`w-4 h-4 ${loading?'animate-spin':''}`}/> تحديث
        </button>
      </div>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Users} label="إجمالي المستخدمين" value={stats.users.total} color="#00A884"/>
        <StatCard icon={CheckCircle2} label="مستخدمون نشطون" value={stats.users.active} color="#22c55e"/>
        <StatCard icon={XCircle} label="موقوفون" value={stats.users.suspended} color="#ef4444"/>
        <StatCard icon={AlertTriangle} label="اشتراكات منتهية" value={stats.users.expired} color="#f59e0b"/>
        <StatCard icon={CreditCard} label="اشتراكات مفتوحة" value={stats.subscriptions.lifetime} color="#8b5cf6"/>
        <StatCard icon={Activity} label="حسابات نشطة" value={stats.accounts.active} sub={`من ${stats.accounts.total} إجمالاً`} color="#3b82f6"/>
        <StatCard icon={TrendingUp} label="تجارب مجانية" value={stats.subscriptions.trial} color="#f59e0b"/>
        <StatCard icon={Shield} label="محاولات دخول فاشلة" sub="آخر 24 ساعة" value={stats.security.failedLogins24h} color="#ef4444"/>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Plan breakdown */}
        <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5">
          <h3 className="font-bold mb-4 flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-[var(--brand-primary)]"/> توزيع الاشتراكات
          </h3>
          <div className="flex flex-col gap-2.5">
            {stats.subscriptions.planBreakdown.length===0
              ? <p className="text-sm text-[var(--text-muted)]">لا توجد بيانات</p>
              : stats.subscriptions.planBreakdown.map((p:any)=>(
                <div key={p.plan_type} className="flex items-center justify-between py-2 border-b border-[var(--border-default)] last:border-0">
                  <span className="text-sm text-[var(--text-secondary)]">{p.plan_type}</span>
                  <span className="font-bold text-sm px-2.5 py-0.5 rounded-full bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">{p.cnt}</span>
                </div>
              ))}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-5">
          <h3 className="font-bold mb-4 flex items-center gap-2">
            <Activity className="w-4 h-4 text-[var(--brand-primary)]"/> آخر النشاطات
          </h3>
          <div className="flex flex-col gap-2">
            {stats.recentActivity.length===0
              ? <p className="text-sm text-[var(--text-muted)]">لا يوجد نشاط</p>
              : stats.recentActivity.slice(0,10).map((log:any, i:number)=>(
                <div key={i} className="flex items-center justify-between py-2 border-b border-[var(--border-default)] last:border-0">
                  <div>
                    <p className="text-sm font-medium">{ACTION_LABELS[log.action]||log.action}</p>
                    <p className="text-xs text-[var(--text-muted)] dir-ltr">@{log.username}</p>
                  </div>
                  <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">
                    {new Date(log.created_at).toLocaleTimeString('ar', {hour:'2-digit', minute:'2-digit'})}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
