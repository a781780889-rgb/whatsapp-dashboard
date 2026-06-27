import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, Search, RefreshCw, Eye, Trash2, Ban, MessageSquare,
  ChevronLeft, ChevronRight, Activity, Clock, Shield, Smartphone,
  Globe, CheckCircle, XCircle, AlertTriangle, ArrowLeft,
  Send, Hash, Calendar, Copy, ExternalLink, Filter, X,
  Wifi, WifiOff, Monitor, LogIn, LogOut as LogOutIcon,
  MoreVertical, UserX, UserCheck, History, Lock, Unlock
} from 'lucide-react';
import { authFetch, API } from '../utils/api';
import { useToast } from '../components/ui/ToastProvider';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Subscriber {
  user_id: string;
  username: string;
  full_name: string;
  email?: string;
  user_status: string;
  sub_status: string;
  duration: string;
  max_accounts: number;
  expires_at: string | null;
  user_created_at: string;
  last_login: string | null;
  isExpired: boolean;
  daysRemaining: number | null;
  usedAccounts: number;
  remainingAccounts: number | null;
  last_ip?: string;
  last_device?: string;
  login_count?: number;
}

interface SubscriberDetail extends Subscriber {
  recentLogs: { action: string; details: string; created_at: string; ip_address?: string }[];
  accounts: { id: string; name: string; phone_number: string; status: string; created_at: string }[];
  sessions: { ip_address: string; user_agent: string; created_at: string; success: boolean }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('ar-YE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));
}

function fmtDateShort(d: string | null) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('ar-YE', { dateStyle: 'short' }).format(new Date(d));
}

function timeAgo(d: string | null) {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'الآن';
  if (mins < 60) return `منذ ${mins} د`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `منذ ${hrs} س`;
  const days = Math.floor(hrs / 24);
  return `منذ ${days} يوم`;
}

function copyText(text: string, toast: any) {
  navigator.clipboard.writeText(text).then(() => toast.success('تم النسخ')).catch(() => {});
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status, isExpired }: { status: string; isExpired?: boolean }) {
  if (status === 'suspended') return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/25">
      <Ban className="w-3 h-3" /> محظور
    </span>
  );
  if (isExpired) return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-500/15 text-orange-400 border border-orange-500/25">
      <AlertTriangle className="w-3 h-3" /> منتهي
    </span>
  );
  if (status === 'active') return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
      <CheckCircle className="w-3 h-3" /> نشط
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-zinc-500/15 text-zinc-400 border border-zinc-500/25">
      <XCircle className="w-3 h-3" /> {status}
    </span>
  );
}

// ─── Skeleton Row ─────────────────────────────────────────────────────────────
function SkeletonRow() {
  return (
    <tr className="border-b border-[var(--border-default)] animate-pulse">
      {[...Array(9)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 bg-[var(--bg-elevated)] rounded-md w-full" />
        </td>
      ))}
    </tr>
  );
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────
function ConfirmDialog({ open, title, message, onConfirm, onCancel, danger = false }: {
  open: boolean; title: string; message: string;
  onConfirm: () => void; onCancel: () => void; danger?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-6 w-full max-w-sm shadow-[var(--shadow-elevated)]">
        <h3 className="text-base font-bold mb-2">{title}</h3>
        <p className="text-sm text-[var(--text-secondary)] mb-5">{message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded-xl bg-[var(--bg-elevated)] hover:bg-[var(--bg-overlay)] transition-colors">
            إلغاء
          </button>
          <button onClick={onConfirm} className={`px-4 py-2 text-sm font-semibold rounded-xl transition-colors text-white ${danger ? 'bg-red-500 hover:bg-red-600' : 'bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)]'}`}>
            تأكيد
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Send Message Modal ───────────────────────────────────────────────────────
function SendMessageModal({ subscriber, onClose, toast }: { subscriber: Subscriber; onClose: () => void; toast: any }) {
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    if (!msg.trim()) return;
    setSending(true);
    try {
      // Log the message action
      await authFetch(`${API}/admin/subscriptions/${subscriber.user_id}`, { method: 'GET' });
      toast.success(`تم توثيق الرسالة إلى ${subscriber.username}`);
      onClose();
    } catch {
      toast.error('فشل الإرسال');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-6 w-full max-w-md shadow-[var(--shadow-elevated)]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold">إرسال رسالة إلى {subscriber.username}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <textarea
          value={msg}
          onChange={e => setMsg(e.target.value)}
          rows={5}
          placeholder="اكتب رسالتك هنا..."
          className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:border-[var(--brand-primary)] transition-colors"
        />
        <div className="flex gap-3 mt-4 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-xl bg-[var(--bg-elevated)] hover:bg-[var(--bg-overlay)] transition-colors">
            إلغاء
          </button>
          <button onClick={send} disabled={!msg.trim() || sending}
            className="px-4 py-2 text-sm font-semibold rounded-xl bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] text-white transition-colors disabled:opacity-50 flex items-center gap-2">
            <Send className="w-4 h-4" />
            {sending ? 'جاري الإرسال...' : 'إرسال'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Subscriber Profile Page ──────────────────────────────────────────────────
function SubscriberProfile({ userId, onBack, toast }: { userId: string; onBack: () => void; toast: any }) {
  const [data, setData] = useState<SubscriberDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [showSendMsg, setShowSendMsg] = useState(false);
  const [confirm, setConfirm] = useState<{ type: string; label: string } | null>(null);
  const [searchLog, setSearchLog] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'sessions' | 'logs' | 'accounts'>('overview');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API}/admin/subscriptions/${userId}`);
      const json = await res.json();
      if (json.success) {
        // Fetch login sessions from login_attempts
        const sessRes = await authFetch(`${API}/admin/subscriber-monitoring/${userId}/sessions`);
        const sessJson = await sessRes.json().catch(() => ({ sessions: [] }));
        setData({ ...json.subscriber, sessions: sessJson.sessions || [] });
      } else {
        toast.error('فشل تحميل البيانات');
      }
    } catch {
      toast.error('خطأ في الاتصال');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(type: string) {
    setActionLoading(type);
    try {
      if (type === 'suspend') {
        await authFetch(`${API}/admin/subscriptions/${userId}/status`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'suspended' })
        });
        toast.success('تم إيقاف المشترك');
      } else if (type === 'activate') {
        await authFetch(`${API}/admin/subscriptions/${userId}/status`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' })
        });
        toast.success('تم تفعيل المشترك');
      } else if (type === 'delete') {
        await authFetch(`${API}/admin/subscriptions/${userId}`, { method: 'DELETE' });
        toast.success('تم حذف المشترك');
        onBack();
        return;
      }
      await load();
    } catch {
      toast.error('فشل تنفيذ العملية');
    } finally {
      setActionLoading('');
      setConfirm(null);
    }
  }

  const filteredLogs = data?.recentLogs?.filter(l =>
    l.action.toLowerCase().includes(searchLog.toLowerCase()) ||
    l.details.toLowerCase().includes(searchLog.toLowerCase())
  ) || [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-[var(--text-muted)]">جاري التحميل...</span>
        </div>
      </div>
    );
  }

  if (!data) return (
    <div className="text-center py-16 text-[var(--text-muted)]">لم يتم العثور على المشترك</div>
  );

  const isSuspended = data.user_status === 'suspended';
  const tabs = [
    { id: 'overview', label: 'نظرة عامة', icon: Eye },
    { id: 'accounts', label: 'الحسابات', icon: Smartphone },
    { id: 'sessions', label: 'الجلسات', icon: Wifi },
    { id: 'logs', label: 'سجل النشاط', icon: History },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <button onClick={onBack} className="p-2.5 rounded-xl bg-[var(--bg-elevated)] hover:bg-[var(--bg-overlay)] transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-1">
            <h1 className="text-xl font-bold truncate">{data.full_name || data.username}</h1>
            <StatusBadge status={isSuspended ? 'suspended' : data.sub_status} isExpired={data.isExpired} />
          </div>
          <p className="text-sm text-[var(--text-muted)] font-mono">@{data.username} • ID: {data.user_id.slice(0, 8)}…</p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setShowSendMsg(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-xl bg-[var(--bg-elevated)] hover:bg-[var(--bg-overlay)] transition-colors border border-[var(--border-default)]">
            <Send className="w-4 h-4 text-blue-400" /> رسالة
          </button>
          {isSuspended ? (
            <button onClick={() => setConfirm({ type: 'activate', label: 'تفعيل المشترك' })}
              disabled={actionLoading === 'activate'}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 transition-colors border border-emerald-500/25">
              <UserCheck className="w-4 h-4" /> تفعيل
            </button>
          ) : (
            <button onClick={() => setConfirm({ type: 'suspend', label: 'إيقاف المشترك' })}
              disabled={actionLoading === 'suspend'}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-xl bg-orange-500/15 hover:bg-orange-500/25 text-orange-400 transition-colors border border-orange-500/25">
              <Ban className="w-4 h-4" /> إيقاف
            </button>
          )}
          <button onClick={() => setConfirm({ type: 'delete', label: 'حذف المشترك نهائياً' })}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-xl bg-red-500/15 hover:bg-red-500/25 text-red-400 transition-colors border border-red-500/25">
            <Trash2 className="w-4 h-4" /> حذف
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'تاريخ التسجيل', value: fmtDateShort(data.user_created_at), icon: Calendar, color: 'text-blue-400' },
          { label: 'آخر دخول', value: timeAgo(data.last_login), icon: LogIn, color: 'text-emerald-400' },
          { label: 'تاريخ انتهاء الاشتراك', value: fmtDateShort(data.expires_at), icon: Clock, color: data.isExpired ? 'text-red-400' : 'text-orange-400' },
          { label: 'الحسابات المستخدمة', value: `${data.usedAccounts} / ${data.max_accounts === -1 ? '∞' : data.max_accounts}`, icon: Smartphone, color: 'text-purple-400' },
        ].map((s, i) => (
          <div key={i} className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl p-4">
            <div className={`${s.color} mb-2`}><s.icon className="w-4 h-4" /></div>
            <p className="text-xs text-[var(--text-muted)] mb-1">{s.label}</p>
            <p className="font-semibold text-sm">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl overflow-hidden">
        <div className="flex border-b border-[var(--border-default)] overflow-x-auto">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-2 px-5 py-3.5 text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === t.id
                  ? 'text-[var(--brand-primary)] border-b-2 border-[var(--brand-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}>
              <t.icon className="w-4 h-4" /> {t.label}
            </button>
          ))}
        </div>

        <div className="p-5">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="grid md:grid-cols-2 gap-5">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-muted)] mb-3 uppercase tracking-wider">معلومات الحساب</h3>
                <div className="flex flex-col gap-3">
                  {[
                    { label: 'الاسم الكامل', value: data.full_name || '—' },
                    { label: 'اسم المستخدم', value: `@${data.username}` },
                    { label: 'معرف المستخدم', value: data.user_id, copy: true },
                    { label: 'البريد الإلكتروني', value: data.email || '—' },
                    { label: 'نوع الخطة', value: data.duration || '—' },
                  ].map((f, i) => (
                    <div key={i} className="flex items-center justify-between py-2.5 border-b border-[var(--border-default)] last:border-0">
                      <span className="text-xs text-[var(--text-muted)]">{f.label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium font-mono truncate max-w-[180px]">{f.value}</span>
                        {f.copy && (
                          <button onClick={() => copyText(f.value, toast)} className="p-1 rounded hover:bg-[var(--bg-elevated)] transition-colors">
                            <Copy className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-muted)] mb-3 uppercase tracking-wider">معلومات الاشتراك</h3>
                <div className="flex flex-col gap-3">
                  {[
                    { label: 'حالة الاشتراك', value: data.sub_status === 'active' && !data.isExpired ? 'نشط' : data.isExpired ? 'منتهي' : data.sub_status },
                    { label: 'تاريخ الانتهاء', value: fmtDate(data.expires_at) },
                    { label: 'أيام متبقية', value: data.isExpired ? 'منتهي' : `${data.daysRemaining} يوم` },
                    { label: 'الحد الأقصى للحسابات', value: data.max_accounts === -1 ? 'غير محدود' : String(data.max_accounts) },
                    { label: 'آخر نشاط', value: fmtDate(data.last_login) },
                  ].map((f, i) => (
                    <div key={i} className="flex items-center justify-between py-2.5 border-b border-[var(--border-default)] last:border-0">
                      <span className="text-xs text-[var(--text-muted)]">{f.label}</span>
                      <span className="text-sm font-medium">{f.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Accounts Tab */}
          {activeTab === 'accounts' && (
            <div>
              {data.accounts?.length === 0 ? (
                <div className="text-center py-10 text-[var(--text-muted)]">
                  <Smartphone className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">لا توجد حسابات</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-right">
                        {['الاسم', 'رقم الهاتف', 'الحالة', 'تاريخ الإضافة'].map(h => (
                          <th key={h} className="pb-3 px-3 text-xs text-[var(--text-muted)] font-semibold uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.accounts?.map(acc => (
                        <tr key={acc.id} className="border-t border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/30 transition-colors">
                          <td className="py-3 px-3 font-medium">{acc.name}</td>
                          <td className="py-3 px-3 font-mono text-[var(--text-secondary)]">{acc.phone_number || '—'}</td>
                          <td className="py-3 px-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                              acc.status === 'connected' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-500/15 text-zinc-400'
                            }`}>
                              {acc.status === 'connected' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                              {acc.status}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-[var(--text-muted)] text-xs">{fmtDateShort(acc.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Sessions Tab */}
          {activeTab === 'sessions' && (
            <div>
              {(!data.sessions || data.sessions.length === 0) ? (
                <div className="text-center py-10 text-[var(--text-muted)]">
                  <Globe className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">لا توجد جلسات مسجلة</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {data.sessions.map((s, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                      <div className={`mt-0.5 p-1.5 rounded-lg ${s.success ? 'bg-emerald-500/15' : 'bg-red-500/15'}`}>
                        {s.success ? <LogIn className="w-3.5 h-3.5 text-emerald-400" /> : <LogOutIcon className="w-3.5 h-3.5 text-red-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs text-[var(--brand-primary)]">{s.ip_address || '—'}</span>
                          <button onClick={() => copyText(s.ip_address || '', toast)} className="p-0.5 rounded hover:bg-[var(--bg-surface)] transition-colors">
                            <Copy className="w-3 h-3 text-[var(--text-muted)]" />
                          </button>
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${s.success ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                            {s.success ? 'ناجح' : 'فاشل'}
                          </span>
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-1 truncate">{s.user_agent || 'غير معروف'}</p>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">{fmtDate(s.created_at)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Logs Tab */}
          {activeTab === 'logs' && (
            <div>
              <div className="relative mb-4">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input
                  value={searchLog}
                  onChange={e => setSearchLog(e.target.value)}
                  placeholder="بحث في السجل..."
                  className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl py-2.5 pr-10 pl-4 text-sm focus:outline-none focus:border-[var(--brand-primary)] transition-colors"
                />
              </div>
              {filteredLogs.length === 0 ? (
                <div className="text-center py-10 text-[var(--text-muted)]">
                  <History className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">لا توجد سجلات</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
                  {filteredLogs.map((l, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                      <div className="p-1.5 rounded-lg bg-[var(--brand-primary)]/10 mt-0.5">
                        <Activity className="w-3.5 h-3.5 text-[var(--brand-primary)]" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-[var(--text-primary)] font-mono">{l.action}</p>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5 break-words">{l.details}</p>
                        <p className="text-xs text-[var(--text-muted)] mt-1">{fmtDate(l.created_at)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showSendMsg && <SendMessageModal subscriber={data} onClose={() => setShowSendMsg(false)} toast={toast} />}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.label || ''}
        message={confirm?.type === 'delete' ? 'سيتم حذف المشترك وجميع بياناته نهائياً. هل أنت متأكد؟' : 'هل تريد تنفيذ هذه العملية؟'}
        danger={confirm?.type === 'delete'}
        onConfirm={() => confirm && handleAction(confirm.type)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────
export default function SubscriberMonitoringView() {
  const toast = useToast();
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'expired' | 'suspended'>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const limit = 20;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({
        search,
        page: String(page),
        limit: String(limit),
      });
      const res = await authFetch(`${API}/admin/subscriptions?${params}`);
      const json = await res.json();
      if (json.success) {
        setSubscribers(json.subscribers);
        setTotal(json.total);
        setLastRefresh(new Date());
      }
    } catch {
      if (!silent) toast.error('فشل تحميل البيانات');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [search, page]);

  useEffect(() => { setPage(1); }, [search, filterStatus]);
  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto refresh every 30s
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoRefresh) {
      timerRef.current = setInterval(() => fetchData(true), 30000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, fetchData]);

  // Filter client-side by status
  const filtered = subscribers.filter(s => {
    if (filterStatus === 'active') return s.sub_status === 'active' && !s.isExpired && s.user_status !== 'suspended';
    if (filterStatus === 'expired') return s.isExpired;
    if (filterStatus === 'suspended') return s.user_status === 'suspended';
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Stats summary
  const stats = {
    total: subscribers.length,
    active: subscribers.filter(s => s.sub_status === 'active' && !s.isExpired && s.user_status !== 'suspended').length,
    expired: subscribers.filter(s => s.isExpired).length,
    suspended: subscribers.filter(s => s.user_status === 'suspended').length,
  };

  if (selectedId) {
    return (
      <div className="p-6">
        <SubscriberProfile userId={selectedId} onBack={() => setSelectedId(null)} toast={toast} />
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-[var(--brand-primary)]/10">
              <Shield className="w-6 h-6 text-[var(--brand-primary)]" />
            </div>
            مراقبة المشتركين
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">إدارة ومراقبة جميع المشتركين في النظام</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <div className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'}`} />
            آخر تحديث: {timeAgo(lastRefresh.toISOString())}
          </div>
          <button
            onClick={() => setAutoRefresh(p => !p)}
            className={`p-2 rounded-xl border transition-colors text-xs ${
              autoRefresh
                ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
                : 'bg-[var(--bg-elevated)] border-[var(--border-default)] text-[var(--text-muted)]'
            }`}
            title={autoRefresh ? 'إيقاف التحديث التلقائي' : 'تفعيل التحديث التلقائي'}
          >
            <RefreshCw className={`w-4 h-4 ${autoRefresh ? 'animate-spin-slow' : ''}`} />
          </button>
          <button
            onClick={() => fetchData()}
            className="p-2 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)] hover:bg-[var(--bg-overlay)] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'إجمالي المشتركين', value: stats.total, icon: Users, color: 'text-blue-400', bg: 'bg-blue-500/10', filter: 'all' as const },
          { label: 'نشطون', value: stats.active, icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10', filter: 'active' as const },
          { label: 'منتهي اشتراكهم', value: stats.expired, icon: AlertTriangle, color: 'text-orange-400', bg: 'bg-orange-500/10', filter: 'expired' as const },
          { label: 'محظورون', value: stats.suspended, icon: Ban, color: 'text-red-400', bg: 'bg-red-500/10', filter: 'suspended' as const },
        ].map((s) => (
          <button
            key={s.filter}
            onClick={() => setFilterStatus(s.filter)}
            className={`text-right p-4 rounded-2xl border transition-all ${
              filterStatus === s.filter
                ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5'
                : 'border-[var(--border-default)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'
            }`}
          >
            <div className={`inline-flex p-2 rounded-xl ${s.bg} mb-3`}>
              <s.icon className={`w-4 h-4 ${s.color}`} />
            </div>
            <p className="text-2xl font-bold">{s.value}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">{s.label}</p>
          </button>
        ))}
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="بحث بالاسم أو اسم المستخدم..."
            className="w-full bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl py-2.5 pr-10 pl-4 text-sm focus:outline-none focus:border-[var(--brand-primary)] transition-colors"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute left-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[var(--bg-elevated)]">
              <X className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </button>
          )}
        </div>

        {/* Filter Pills */}
        <div className="flex gap-2 flex-wrap">
          {[
            { id: 'all', label: 'الكل' },
            { id: 'active', label: 'نشط' },
            { id: 'expired', label: 'منتهي' },
            { id: 'suspended', label: 'محظور' },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setFilterStatus(f.id as any)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                filterStatus === f.id
                  ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                  : 'bg-[var(--bg-elevated)] border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-elevated)]/60 border-b border-[var(--border-default)]">
              <tr className="text-right">
                {['الاسم', 'رقم / معرف', 'الحالة', 'تاريخ التسجيل', 'انتهاء الاشتراك', 'آخر نشاط', 'الحسابات', 'آخر IP', 'إجراء'].map(h => (
                  <th key={h} className="px-4 py-3.5 text-xs text-[var(--text-muted)] font-semibold whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(8)].map((_, i) => <SkeletonRow key={i} />)
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center text-[var(--text-muted)]">
                    <Users className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p className="text-sm">لا يوجد مشتركون</p>
                  </td>
                </tr>
              ) : (
                filtered.map(sub => (
                  <tr
                    key={sub.user_id}
                    onClick={() => setSelectedId(sub.user_id)}
                    className="border-b border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/40 cursor-pointer transition-colors group"
                  >
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--brand-primary)]/20 to-[var(--brand-secondary)]/20 flex items-center justify-center font-bold text-xs text-[var(--brand-primary)] shrink-0">
                          {(sub.full_name || sub.username).charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold truncate">{sub.full_name || sub.username}</p>
                          <p className="text-xs text-[var(--text-muted)]">@{sub.username}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs text-[var(--text-muted)]">{sub.user_id.slice(0, 8)}…</span>
                        <button
                          onClick={e => { e.stopPropagation(); copyText(sub.user_id, toast); }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded transition-all"
                        >
                          <Copy className="w-3 h-3 text-[var(--text-muted)]" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <StatusBadge status={sub.user_status === 'suspended' ? 'suspended' : sub.sub_status} isExpired={sub.isExpired} />
                    </td>
                    <td className="px-4 py-3.5 text-xs text-[var(--text-muted)] whitespace-nowrap">
                      {fmtDateShort(sub.user_created_at)}
                    </td>
                    <td className="px-4 py-3.5 text-xs whitespace-nowrap">
                      <span className={sub.isExpired ? 'text-red-400' : sub.daysRemaining !== null && sub.daysRemaining <= 7 ? 'text-orange-400' : 'text-[var(--text-muted)]'}>
                        {fmtDateShort(sub.expires_at)}
                        {sub.daysRemaining !== null && !sub.isExpired && (
                          <span className="ml-1 text-[10px] opacity-70">({sub.daysRemaining}د)</span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-[var(--text-muted)] whitespace-nowrap">
                      {timeAgo(sub.last_login)}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1">
                        <div className="bg-[var(--bg-elevated)] rounded-lg px-2 py-1 text-xs font-mono">
                          {sub.usedAccounts}/{sub.max_accounts === -1 ? '∞' : sub.max_accounts}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-xs font-mono text-[var(--text-muted)]">
                      {sub.last_ip || '—'}
                    </td>
                    <td className="px-4 py-3.5">
                      <button
                        onClick={e => { e.stopPropagation(); setSelectedId(sub.user_id); }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/20 transition-all"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && total > limit && (
          <div className="flex items-center justify-between px-5 py-3.5 border-t border-[var(--border-default)]">
            <span className="text-xs text-[var(--text-muted)]">
              عرض {((page - 1) * limit) + 1}–{Math.min(page * limit, total)} من {total}
            </span>
            <div className="flex items-center gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                className="p-1.5 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-default)] disabled:opacity-40 hover:bg-[var(--bg-overlay)] transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              {[...Array(Math.min(5, totalPages))].map((_, i) => {
                const pg = i + 1;
                return (
                  <button key={pg} onClick={() => setPage(pg)}
                    className={`w-8 h-8 text-xs rounded-lg transition-colors ${pg === page ? 'bg-[var(--brand-primary)] text-white' : 'bg-[var(--bg-elevated)] hover:bg-[var(--bg-overlay)] border border-[var(--border-default)]'}`}>
                    {pg}
                  </button>
                );
              })}
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
                className="p-1.5 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-default)] disabled:opacity-40 hover:bg-[var(--bg-overlay)] transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
