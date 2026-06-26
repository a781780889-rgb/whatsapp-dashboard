import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  MessageCircle, Plus, RefreshCw, Loader2, X, Trash2, Copy,
  ExternalLink, CheckCircle2, Search, Filter, Download,
  Users, Wifi, WifiOff, Activity, Link2, Eye, MoreHorizontal,
  Play, Square, AlertTriangle, Check, ChevronDown, Calendar,
  CheckSquare, FileSpreadsheet, Bell, Shield, Info, Phone,
  BarChart3, TrendingUp, Clock, Database, Zap, Settings,
  Pencil
} from 'lucide-react';
import { API, authFetch } from '../utils/api';
import { useToast } from '../components/ui/ToastProvider';
import { io, Socket } from 'socket.io-client';
import { cn } from '@/utils/cn';

// ── Types ─────────────────────────────────────────────────────────────────────
interface TelegramAccount {
  id: string; name: string; phone_number: string; api_id: string;
  api_hash: string; session_string: string; status: string;
  last_activity_at: string; links_collected: number;
  channels_monitored: number; notes: string; created_at: string;
}

interface WaLink {
  id: string; whatsapp_link: string; source_account_id: string;
  source_account_name: string; source_group: string; discovered_at: string;
  last_seen: string; duplicate_count: number; status: string;
  joined: boolean; copied: boolean; deleted: boolean; notes: string;
}

interface Stats {
  totalAccounts: number; connectedAccounts: number; disconnectedAccounts: number;
  totalLinks: number; newLinks: number; joinedLinks: number;
  deletedLinks: number; duplicateLinks: number;
  perAccount: { id: string; name: string; phone_number: string; links_count: number }[];
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, color, icon: Icon, sub }:
  { label: string; value: number|string; color: string; icon: any; sub?: string }) {
  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 flex items-start gap-3">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0`}
        style={{ background: `${color}20` }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-[var(--text-muted)] mb-0.5">{label}</p>
        <p className="text-xl font-bold">{value}</p>
        {sub && <p className="text-xs text-[var(--text-muted)] mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Account Form Modal ────────────────────────────────────────────────────────
function AccountModal({ account, onClose, onSave }:
  { account?: TelegramAccount | null; onClose: () => void; onSave: () => void }) {
  const [form, setForm] = useState({
    name: account?.name || '',
    phone_number: account?.phone_number || '',
    api_id: account?.api_id || '',
    api_hash: account?.api_hash || '',
    session_string: account?.session_string || '',
    notes: account?.notes || '',
  });
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  function set(k: string, v: string) { setForm(p => ({ ...p, [k]: v })); }

  async function submit() {
    if (!form.name.trim() || !form.phone_number.trim()) {
      addToast({ title: 'خطأ', description: 'الاسم ورقم الهاتف مطلوبان', type: 'error' }); return;
    }
    setLoading(true);
    try {
      const url = account ? `${API}/telegram/accounts/${account.id}` : `${API}/telegram/accounts`;
      const method = account ? 'PUT' : 'POST';
      const res = await authFetch(url, { method, body: JSON.stringify(form) });
      const data = await res.json();
      if (data.success) {
        addToast({ title: '✅ تم الحفظ', description: `تم ${account ? 'تعديل' : 'إضافة'} الحساب`, type: 'success' });
        onSave();
      } else {
        addToast({ title: 'خطأ', description: data.error, type: 'error' });
      }
    } finally { setLoading(false); }
  }

  const inputCls = "w-full px-3 py-2.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)] text-sm focus:outline-none focus:border-[var(--brand-primary)] transition-colors placeholder:text-[var(--text-muted)]";
  const labelCls = "block text-xs font-semibold text-[var(--text-muted)] mb-1.5 uppercase tracking-wide";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-2xl shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <div className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-[var(--brand-primary)]" />
            <h3 className="font-bold text-lg">{account ? 'تعديل حساب تيليجرام' : 'إضافة حساب تيليجرام'}</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>اسم الحساب *</label>
              <input className={inputCls} value={form.name} onChange={e => set('name', e.target.value)}
                placeholder="مثال: حساب مراقبة 1" />
            </div>
            <div>
              <label className={labelCls}>رقم الهاتف *</label>
              <input className={inputCls} value={form.phone_number} onChange={e => set('phone_number', e.target.value)}
                placeholder="+966xxxxxxxxx" dir="ltr" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>API ID</label>
              <input className={inputCls} value={form.api_id} onChange={e => set('api_id', e.target.value)}
                placeholder="12345678" dir="ltr" />
            </div>
            <div>
              <label className={labelCls}>API Hash</label>
              <input className={inputCls} value={form.api_hash} onChange={e => set('api_hash', e.target.value)}
                placeholder="abc123def456..." dir="ltr" />
            </div>
          </div>
          <div>
            <label className={labelCls}>Session String</label>
            <textarea className={cn(inputCls, "min-h-[80px] resize-none font-mono text-xs")}
              value={form.session_string} onChange={e => set('session_string', e.target.value)}
              placeholder="BQA..." dir="ltr" />
            <p className="text-xs text-[var(--text-muted)] mt-1">
              احصل على الـ session string من telethon أو pyrogram
            </p>
          </div>
          <div>
            <label className={labelCls}>ملاحظات</label>
            <input className={inputCls} value={form.notes} onChange={e => set('notes', e.target.value)}
              placeholder="ملاحظات اختيارية..." />
          </div>
        </div>

        <div className="flex gap-3 px-6 pb-6">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[var(--border-default)] text-sm font-semibold hover:bg-[var(--bg-elevated)] transition-colors">
            إلغاء
          </button>
          <button onClick={submit} disabled={loading}
            className="flex-1 py-2.5 rounded-xl bg-[var(--brand-primary)] text-white text-sm font-bold hover:brightness-110 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {account ? 'حفظ التعديلات' : 'إضافة الحساب'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Link Info Modal ───────────────────────────────────────────────────────────
function LinkInfoModal({ link, onClose }: { link: WaLink; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-2xl shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h3 className="font-bold flex items-center gap-2"><Info className="w-4 h-4 text-[var(--brand-primary)]" />تفاصيل الرابط</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <div className="p-3 rounded-xl bg-[var(--bg-elevated)] font-mono text-xs break-all text-[var(--brand-primary)] select-all">
            {link.whatsapp_link}
          </div>
          {[
            ['الحساب المصدر', link.source_account_name],
            ['المجموعة/القناة', link.source_group],
            ['تاريخ الاكتشاف', link.discovered_at ? new Date(link.discovered_at).toLocaleString('ar-SA') : '-'],
            ['آخر ظهور', link.last_seen ? new Date(link.last_seen).toLocaleString('ar-SA') : '-'],
            ['عدد التكرار', String(link.duplicate_count)],
            ['الحالة', link.status],
          ].map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-2">
              <span className="text-[var(--text-muted)] shrink-0">{k}:</span>
              <span className="font-medium text-left break-all">{v || '-'}</span>
            </div>
          ))}
          <div className="flex gap-2 mt-1">
            {link.joined && <span className="px-2 py-0.5 rounded-full text-xs bg-green-500/15 text-green-400">✅ تم الانضمام</span>}
            {link.copied && <span className="px-2 py-0.5 rounded-full text-xs bg-blue-500/15 text-blue-400">📋 تم النسخ</span>}
            {link.deleted && <span className="px-2 py-0.5 rounded-full text-xs bg-red-500/15 text-red-400">🗑️ محذوف</span>}
          </div>
          {link.notes && <p className="text-[var(--text-muted)] text-xs mt-1 p-2 rounded-lg bg-[var(--bg-elevated)]">{link.notes}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function TelegramView() {
  const [tab, setTab] = useState<'accounts' | 'links'>('accounts');
  const [accounts, setAccounts] = useState<TelegramAccount[]>([]);
  const [links, setLinks] = useState<WaLink[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [linksLoading, setLinksLoading] = useState(false);

  const [showModal, setShowModal] = useState(false);
  const [editAccount, setEditAccount] = useState<TelegramAccount | null>(null);
  const [infoLink, setInfoLink] = useState<WaLink | null>(null);

  // Links filters
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterAccount, setFilterAccount] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const LIMIT = 50;

  // Selected links for bulk
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { addToast } = useToast();
  const socketRef = useRef<Socket | null>(null);

  // ── Socket.IO realtime ────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io({ path: '/socket.io', transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('telegram:new_link', (link: WaLink) => {
      setLinks(prev => [link, ...prev.slice(0, LIMIT - 1)]);
      setTotal(p => p + 1);
      setStats(prev => prev ? { ...prev, totalLinks: prev.totalLinks + 1, newLinks: prev.newLinks + 1 } : prev);
      addToast({ title: '🔗 رابط جديد', description: link.whatsapp_link.slice(0, 50), type: 'success' });
    });

    socket.on('telegram:link_duplicate', ({ linkId, duplicate_count }: any) => {
      setLinks(prev => prev.map(l => l.id === linkId ? { ...l, duplicate_count } : l));
      setStats(prev => prev ? { ...prev, duplicateLinks: prev.duplicateLinks + 1 } : prev);
    });

    socket.on('telegram:worker_started', ({ accountId }: any) => {
      setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, status: 'connected' } : a));
    });

    socket.on('telegram:worker_stopped', ({ accountId }: any) => {
      setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, status: 'disconnected' } : a));
    });

    return () => { socket.disconnect(); };
  }, []); // eslint-disable-line

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API}/telegram/accounts`);
      const data = await res.json();
      if (data.success) setAccounts(data.accounts);
    } finally { setLoading(false); }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/telegram/accounts/stats`);
      const data = await res.json();
      if (data.success) setStats(data.stats);
    } catch {}
  }, []);

  const fetchLinks = useCallback(async () => {
    setLinksLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page), limit: String(LIMIT),
        ...(search && { search }),
        ...(filterStatus && { status: filterStatus }),
        ...(filterAccount && { account_id: filterAccount }),
        ...(filterDateFrom && { date_from: filterDateFrom }),
        ...(filterDateTo && { date_to: filterDateTo }),
      });
      const res = await authFetch(`${API}/telegram/links?${params}`);
      const data = await res.json();
      if (data.success) {
        setLinks(data.links);
        setTotal(data.total);
      }
    } finally { setLinksLoading(false); }
  }, [page, search, filterStatus, filterAccount, filterDateFrom, filterDateTo]);

  useEffect(() => { fetchAccounts(); fetchStats(); }, []);
  useEffect(() => { if (tab === 'links') fetchLinks(); }, [tab, fetchLinks]);

  // ── Account actions ───────────────────────────────────────────────────────
  async function deleteAccount(id: string) {
    if (!confirm('هل أنت متأكد من حذف هذا الحساب؟')) return;
    const res = await authFetch(`${API}/telegram/accounts/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { addToast({ title: 'تم الحذف', type: 'success' }); fetchAccounts(); fetchStats(); }
    else addToast({ title: 'خطأ', description: data.error, type: 'error' });
  }

  async function toggleWorker(account: TelegramAccount) {
    const action = account.status === 'connected' ? 'stop' : 'start';
    const res = await authFetch(`${API}/telegram/accounts/${account.id}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) { fetchAccounts(); fetchStats(); }
    else addToast({ title: 'خطأ', description: data.error, type: 'error' });
  }

  // ── Link actions ──────────────────────────────────────────────────────────
  async function updateLink(id: string, patch: Record<string, any>) {
    const res = await authFetch(`${API}/telegram/links/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const data = await res.json();
    if (data.success) {
      setLinks(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
    }
  }

  async function deleteLink(id: string) {
    if (!confirm('تأكيد حذف الرابط؟')) return;
    const res = await authFetch(`${API}/telegram/links/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) fetchLinks();
  }

  async function bulkDelete(deleteJoined = false) {
    if (!deleteJoined && selected.size === 0) return;
    if (!confirm(deleteJoined ? 'حذف جميع الروابط التي تم الانضمام إليها؟' : `حذف ${selected.size} رابط؟`)) return;
    const res = await authFetch(`${API}/telegram/links/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify(deleteJoined ? { deleteJoined: true } : { ids: [...selected] }),
    });
    const data = await res.json();
    if (data.success) { setSelected(new Set()); fetchLinks(); fetchStats(); }
  }

  function copyLink(link: string) {
    navigator.clipboard.writeText(link);
    addToast({ title: '📋 تم النسخ', type: 'success' });
  }

  async function exportCSV() {
    const params = new URLSearchParams({
      ...(filterStatus && { status: filterStatus }),
      ...(filterAccount && { account_id: filterAccount }),
    });
    window.open(`${API}/telegram/links/export?${params}`, '_blank');
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }

  function selectAll() {
    if (selected.size === links.length) setSelected(new Set());
    else setSelected(new Set(links.map(l => l.id)));
  }

  const statusColor: Record<string, string> = {
    new:       'bg-blue-500/15 text-blue-400',
    processed: 'bg-yellow-500/15 text-yellow-400',
    joined:    'bg-green-500/15 text-green-400',
    deleted:   'bg-red-500/15 text-red-400',
  };

  const inputCls = "px-3 py-2 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)] text-sm focus:outline-none focus:border-[var(--brand-primary)] transition-colors placeholder:text-[var(--text-muted)]";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-5 h-full">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[#2CA5E0] to-[#1e88b5] flex items-center justify-center shadow-lg">
            <MessageCircle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">إدارة تيليجرام</h1>
            <p className="text-xs text-[var(--text-muted)]">مراقبة القنوات وجمع روابط واتساب تلقائياً</p>
          </div>
        </div>
        <button onClick={() => { setEditAccount(null); setShowModal(true); }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#2CA5E0] text-white text-sm font-bold hover:brightness-110 transition-all shadow-md">
          <Plus className="w-4 h-4" />
          إضافة حساب
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          <StatCard label="الحسابات" value={stats.totalAccounts} color="#2CA5E0" icon={Users} />
          <StatCard label="متصل" value={stats.connectedAccounts} color="#22c55e" icon={Wifi} />
          <StatCard label="غير متصل" value={stats.disconnectedAccounts} color="#ef4444" icon={WifiOff} />
          <StatCard label="إجمالي الروابط" value={stats.totalLinks} color="#8b5cf6" icon={Link2} />
          <StatCard label="جديدة (24h)" value={stats.newLinks} color="#f59e0b" icon={TrendingUp} />
          <StatCard label="تم الانضمام" value={stats.joinedLinks} color="#00A884" icon={CheckCircle2} />
          <StatCard label="محذوفة" value={stats.deletedLinks} color="#6b7280" icon={Trash2} />
          <StatCard label="مكررة متجاهلة" value={stats.duplicateLinks} color="#3b82f6" icon={Database} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-[var(--bg-elevated)] rounded-2xl w-fit">
        {[
          { id: 'accounts', label: 'الحسابات', icon: Users },
          { id: 'links', label: 'روابط واتساب', icon: Link2 },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id as any)}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all',
              tab === t.id
                ? 'bg-[#2CA5E0] text-white shadow'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            )}>
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── ACCOUNTS TAB ─────────────────────────────────────────────────── */}
      {tab === 'accounts' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--text-muted)]">{accounts.length} حساب</p>
            <button onClick={() => { fetchAccounts(); fetchStats(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-[var(--border-default)] hover:bg-[var(--bg-elevated)] transition-colors text-[var(--text-muted)]">
              <RefreshCw className="w-3.5 h-3.5" /> تحديث
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-7 h-7 animate-spin text-[#2CA5E0]" />
            </div>
          ) : accounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-[var(--text-muted)]">
              <MessageCircle className="w-12 h-12 opacity-20" />
              <p className="font-medium">لا توجد حسابات تيليجرام</p>
              <button onClick={() => setShowModal(true)}
                className="mt-2 px-4 py-2 rounded-xl bg-[#2CA5E0] text-white text-sm font-bold">
                إضافة أول حساب
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-default)] text-[var(--text-muted)]">
                    {['الاسم', 'رقم الهاتف', 'الحالة', 'آخر نشاط', 'الروابط المجمّعة', 'القنوات', 'الإجراءات'].map(h => (
                      <th key={h} className="text-right px-4 py-3 font-semibold text-xs uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(acc => (
                    <tr key={acc.id} className="border-b border-[var(--border-default)] hover:bg-[var(--bg-elevated)] transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-xl bg-[#2CA5E0]/15 flex items-center justify-center">
                            <MessageCircle className="w-4 h-4 text-[#2CA5E0]" />
                          </div>
                          <div>
                            <p className="font-semibold">{acc.name}</p>
                            {acc.notes && <p className="text-xs text-[var(--text-muted)]">{acc.notes}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs" dir="ltr">{acc.phone_number}</td>
                      <td className="px-4 py-3">
                        <span className={cn('px-2.5 py-1 rounded-full text-xs font-bold',
                          acc.status === 'connected' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400')}>
                          {acc.status === 'connected' ? '🟢 متصل' : '🔴 غير متصل'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                        {acc.last_activity_at ? new Date(acc.last_activity_at).toLocaleString('ar-SA') : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-bold text-[#2CA5E0]">{acc.links_collected || 0}</span>
                      </td>
                      <td className="px-4 py-3 text-[var(--text-muted)]">{acc.channels_monitored || 0}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button onClick={() => toggleWorker(acc)} title={acc.status === 'connected' ? 'إيقاف' : 'تشغيل'}
                            className={cn('p-1.5 rounded-lg transition-colors',
                              acc.status === 'connected'
                                ? 'text-orange-400 hover:bg-orange-500/10'
                                : 'text-green-400 hover:bg-green-500/10')}>
                            {acc.status === 'connected' ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                          </button>
                          <button onClick={() => { setEditAccount(acc); setShowModal(true); }}
                            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/10 transition-colors">
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button onClick={() => deleteAccount(acc.id)}
                            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Per-account stats */}
          {stats?.perAccount && stats.perAccount.length > 0 && (
            <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4">
              <h3 className="font-bold text-sm mb-3 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-[#2CA5E0]" /> إنتاجية كل حساب
              </h3>
              <div className="space-y-2">
                {stats.perAccount.map(acc => {
                  const max = Math.max(...stats.perAccount.map(a => Number(a.links_count)), 1);
                  const pct = Math.round((Number(acc.links_count) / max) * 100);
                  return (
                    <div key={acc.id} className="flex items-center gap-3">
                      <span className="text-xs text-[var(--text-muted)] w-28 truncate shrink-0">{acc.name}</span>
                      <div className="flex-1 h-2 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
                        <div className="h-full bg-[#2CA5E0] rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs font-bold w-10 text-left shrink-0">{acc.links_count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── LINKS TAB ────────────────────────────────────────────────────── */}
      {tab === 'links' && (
        <div className="flex flex-col gap-4">
          {/* Bulk actions */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input className={cn(inputCls, "pr-9 w-full")} placeholder="بحث في الروابط..."
                value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
            </div>

            {/* Filters */}
            <select className={inputCls} value={filterStatus}
              onChange={e => { setFilterStatus(e.target.value); setPage(1); }}>
              <option value="">كل الحالات</option>
              <option value="new">🔵 جديد</option>
              <option value="processed">🟡 تمت المعالجة</option>
              <option value="joined">🟢 تم الانضمام</option>
            </select>

            <select className={inputCls} value={filterAccount}
              onChange={e => { setFilterAccount(e.target.value); setPage(1); }}>
              <option value="">كل الحسابات</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>

            <input type="date" className={inputCls} value={filterDateFrom}
              onChange={e => { setFilterDateFrom(e.target.value); setPage(1); }} title="من تاريخ" />
            <input type="date" className={inputCls} value={filterDateTo}
              onChange={e => { setFilterDateTo(e.target.value); setPage(1); }} title="إلى تاريخ" />

            <div className="flex gap-1 mr-auto">
              {selected.size > 0 && (
                <>
                  <button onClick={() => {
                    const text = links.filter(l => selected.has(l.id)).map(l => l.whatsapp_link).join('\n');
                    navigator.clipboard.writeText(text);
                    addToast({ title: '📋 تم النسخ', type: 'success' });
                  }} className="px-3 py-2 rounded-xl text-xs bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors font-semibold flex items-center gap-1.5">
                    <Copy className="w-3.5 h-3.5" /> نسخ ({selected.size})
                  </button>
                  <button onClick={() => bulkDelete()}
                    className="px-3 py-2 rounded-xl text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors font-semibold flex items-center gap-1.5">
                    <Trash2 className="w-3.5 h-3.5" /> حذف ({selected.size})
                  </button>
                </>
              )}
              <button onClick={() => bulkDelete(true)}
                className="px-3 py-2 rounded-xl text-xs border border-[var(--border-default)] hover:bg-[var(--bg-elevated)] transition-colors font-semibold flex items-center gap-1.5 text-[var(--text-muted)]">
                <Trash2 className="w-3.5 h-3.5" /> حذف المنضمة
              </button>
              <button onClick={exportCSV}
                className="px-3 py-2 rounded-xl text-xs bg-[var(--bg-elevated)] hover:bg-[var(--bg-overlay)] transition-colors font-semibold flex items-center gap-1.5 text-[var(--text-muted)]">
                <Download className="w-3.5 h-3.5" /> تصدير CSV
              </button>
              <button onClick={fetchLinks}
                className="px-3 py-2 rounded-xl text-xs bg-[var(--bg-elevated)] hover:bg-[var(--bg-overlay)] transition-colors font-semibold flex items-center gap-1.5 text-[var(--text-muted)]">
                <RefreshCw className={cn("w-3.5 h-3.5", linksLoading && "animate-spin")} /> تحديث
              </button>
            </div>
          </div>

          {/* Links Table */}
          {linksLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-7 h-7 animate-spin text-[#2CA5E0]" />
            </div>
          ) : links.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-[var(--text-muted)]">
              <Link2 className="w-12 h-12 opacity-20" />
              <p className="font-medium">لا توجد روابط واتساب بعد</p>
              <p className="text-xs text-center max-w-xs">
                أضف حسابات تيليجرام وابدأ المراقبة لتبدأ روابط واتساب بالظهور هنا تلقائياً
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border-default)] text-[var(--text-muted)]">
                      <th className="px-3 py-3">
                        <input type="checkbox"
                          checked={selected.size === links.length && links.length > 0}
                          onChange={selectAll}
                          className="w-4 h-4 rounded" />
                      </th>
                      {['رابط واتساب', 'الحساب', 'المجموعة/القناة', 'تاريخ الاكتشاف', 'تكرار', 'الحالة', 'إجراءات'].map(h => (
                        <th key={h} className="text-right px-3 py-3 font-semibold text-xs uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {links.map(link => (
                      <tr key={link.id} className={cn(
                        "border-b border-[var(--border-default)] hover:bg-[var(--bg-elevated)] transition-colors",
                        selected.has(link.id) && "bg-[#2CA5E0]/5"
                      )}>
                        <td className="px-3 py-2.5">
                          <input type="checkbox" checked={selected.has(link.id)} onChange={() => toggleSelect(link.id)}
                            className="w-4 h-4 rounded" />
                        </td>
                        <td className="px-3 py-2.5 max-w-[220px]">
                          <span className="font-mono text-xs text-[var(--brand-primary)] truncate block"
                            title={link.whatsapp_link}>
                            {link.whatsapp_link}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">
                          {link.source_account_name || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-[var(--text-muted)] max-w-[160px] truncate"
                          title={link.source_group}>
                          {link.source_group || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">
                          {link.discovered_at ? new Date(link.discovered_at).toLocaleDateString('ar-SA') : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          {link.duplicate_count > 0
                            ? <span className="px-1.5 py-0.5 rounded-full text-xs bg-yellow-500/15 text-yellow-400 font-bold">{link.duplicate_count}×</span>
                            : <span className="text-xs text-[var(--text-muted)]">—</span>
                          }
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={cn('px-2 py-0.5 rounded-full text-xs font-semibold', statusColor[link.status] || 'bg-[var(--bg-elevated)] text-[var(--text-muted)]')}>
                            {link.status === 'new' ? 'جديد' : link.status === 'processed' ? 'معالج' : link.status === 'joined' ? 'منضم' : link.status}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-0.5">
                            <button onClick={() => copyLink(link.whatsapp_link)} title="نسخ"
                              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            <a href={link.whatsapp_link} target="_blank" rel="noreferrer" title="فتح"
                              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-green-400 hover:bg-green-500/10 transition-colors">
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                            <button onClick={() => updateLink(link.id, { status: 'processed', joined: false })}
                              title="تمت المعالجة"
                              className={cn('p-1.5 rounded-lg transition-colors',
                                link.status === 'processed'
                                  ? 'text-yellow-400 bg-yellow-500/10'
                                  : 'text-[var(--text-muted)] hover:text-yellow-400 hover:bg-yellow-500/10')}>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => updateLink(link.id, { joined: !link.joined, status: link.joined ? 'processed' : 'joined' })}
                              title="تم الانضمام"
                              className={cn('p-1.5 rounded-lg transition-colors',
                                link.joined
                                  ? 'text-green-400 bg-green-500/10'
                                  : 'text-[var(--text-muted)] hover:text-green-400 hover:bg-green-500/10')}>
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setInfoLink(link)} title="تفاصيل"
                              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors">
                              <Info className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => deleteLink(link.id)} title="حذف"
                              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {total > LIMIT && (
                <div className="flex items-center justify-between text-sm">
                  <p className="text-[var(--text-muted)] text-xs">{total} رابط إجمالاً — صفحة {page}</p>
                  <div className="flex gap-2">
                    <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                      className="px-3 py-1.5 rounded-lg border border-[var(--border-default)] text-xs disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">
                      السابق
                    </button>
                    <button disabled={page * LIMIT >= total} onClick={() => setPage(p => p + 1)}
                      className="px-3 py-1.5 rounded-lg border border-[var(--border-default)] text-xs disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">
                      التالي
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Modals */}
      {showModal && (
        <AccountModal
          account={editAccount}
          onClose={() => { setShowModal(false); setEditAccount(null); }}
          onSave={() => { setShowModal(false); setEditAccount(null); fetchAccounts(); fetchStats(); }}
        />
      )}
      {infoLink && <LinkInfoModal link={infoLink} onClose={() => setInfoLink(null)} />}
    </div>
  );
}
