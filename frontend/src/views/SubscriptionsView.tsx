import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    CreditCard, Plus, Search, XCircle, RefreshCw, Loader2, X,
    CheckCircle, Clock, Snowflake, Play, Trash2, Download,
    BarChart3, Calendar, TrendingUp, Users, AlertTriangle,
    Infinity, ChevronLeft, ChevronRight, History, PenLine, Filter
} from 'lucide-react';
import { API, authFetch } from '../utils/api';
import { useToast } from '../components/ui/ToastProvider';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Sub {
    id: string;
    user_id: string;
    username: string;
    full_name: string;
    email: string;
    plan_type: string;
    planLabel: string;
    started_at: string;
    expires_at: string | null;
    status: string;
    daysRemaining: number;
    isExpired: boolean;
    note: string;
    frozen_at: string | null;
}

interface Stats {
    total: number;
    active: number;
    expired: number;
    frozen: number;
    lifetime: number;
    expiringSoon: number;
    byPlan: { plan_type: string; cnt: string }[];
    growth: { day: string; cnt: string }[];
}

interface Plan { id: string; label: string; hours: number | null; }

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_OPTIONS = [
    { value: '',          label: 'كل الاشتراكات' },
    { value: 'active',    label: '✅ نشط' },
    { value: 'frozen',    label: '🧊 مجمّد' },
    { value: 'cancelled', label: '❌ ملغي' },
];

// ── Status Badge ──────────────────────────────────────────────────────────────
function StatusBadge({ sub }: { sub: Sub }) {
    if (sub.plan_type === 'lifetime')
        return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]">♾️ دائم</span>;
    if (sub.status === 'frozen')
        return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-sky-500/15 text-sky-400">🧊 مجمّد</span>;
    if (sub.status === 'cancelled' || sub.isExpired)
        return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/15 text-red-400">منتهي</span>;
    if (sub.daysRemaining <= 1)
        return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/15 text-red-400 animate-pulse">⚠️ ينتهي اليوم</span>;
    if (sub.daysRemaining <= 3)
        return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-orange-500/15 text-orange-400">⏰ {sub.daysRemaining} أيام</span>;
    if (sub.daysRemaining <= 7)
        return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-500/15 text-yellow-400">{sub.daysRemaining} أيام</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-500/15 text-green-400">{sub.daysRemaining} يوم</span>;
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, color, sub }: {
    icon: React.ReactNode; label: string; value: number | string; color: string; sub?: string;
}) {
    return (
        <div className={`bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 flex items-center gap-4 hover:border-[var(--border-strong)] transition-colors`}>
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${color}`}>{icon}</div>
            <div>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-sm text-[var(--text-muted)]">{label}</p>
                {sub && <p className="text-xs text-[var(--text-muted)] mt-0.5">{sub}</p>}
            </div>
        </div>
    );
}

// ── Create Subscription Modal ─────────────────────────────────────────────────
function CreateModal({ plans, onClose, onSave }: { plans: Plan[]; onClose: () => void; onSave: () => void }) {
    const [userId, setUserId]   = useState('');
    const [planType, setPlan]   = useState('30d');
    const [note, setNote]       = useState('');
    const [users, setUsers]     = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const { addToast } = useToast();

    useEffect(() => {
        authFetch(`${API}/admin/users?limit=500`)
            .then(r => r.json())
            .then(d => { if (d.success) setUsers(d.users); });
    }, []);

    async function submit() {
        if (!userId || !planType) return;
        setLoading(true);
        try {
            const res  = await authFetch(`${API}/admin/subscriptions`, {
                method: 'POST',
                body: JSON.stringify({ userId, planType, note })
            });
            const data = await res.json();
            if (data.success) {
                addToast({ title: '✅ تم', description: 'تم إنشاء الاشتراك بنجاح', type: 'success' });
                onSave();
            } else {
                addToast({ title: 'خطأ', description: data.error, type: 'error' });
            }
        } finally { setLoading(false); }
    }

    return (
        <ModalWrapper title="إنشاء اشتراك جديد" icon={<Plus className="w-5 h-5"/>} onClose={onClose}>
            <div className="flex flex-col gap-4">
                <Field label="المستخدم">
                    <select value={userId} onChange={e => setUserId(e.target.value)} className="input" required>
                        <option value="">اختر مستخدماً...</option>
                        {users.map(u => (
                            <option key={u.id} value={u.id}>
                                {u.full_name || u.username} (@{u.username})
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="خطة الاشتراك">
                    <select value={planType} onChange={e => setPlan(e.target.value)} className="input">
                        {plans.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                </Field>
                <Field label="ملاحظة (اختياري)">
                    <input value={note} onChange={e => setNote(e.target.value)} className="input"
                        placeholder="مثال: اشتراك تجريبي، هدية..." />
                </Field>
                <div className="flex gap-3 pt-2">
                    <button onClick={submit} disabled={loading || !userId}
                        className="flex-1 h-11 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                        {loading && <Loader2 className="w-4 h-4 animate-spin"/>} إنشاء الاشتراك
                    </button>
                    <button onClick={onClose} className="flex-1 h-11 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-all">
                        إلغاء
                    </button>
                </div>
            </div>
        </ModalWrapper>
    );
}

// ── Extend Modal ──────────────────────────────────────────────────────────────
function ExtendModal({ sub, onClose, onSave }: { sub: Sub; onClose: () => void; onSave: () => void }) {
    const [days, setDays]       = useState('');
    const [hours, setHours]     = useState('');
    const [note, setNote]       = useState('');
    const [loading, setLoading] = useState(false);
    const { addToast } = useToast();

    const totalHours = (Number(days || 0) * 24) + Number(hours || 0);

    // حساب الانتهاء الجديد
    let newExpiry = '—';
    if (totalHours > 0) {
        const base = sub.expires_at ? new Date(sub.expires_at) : new Date();
        const d = new Date(base.getTime() + totalHours * 3600000);
        newExpiry = d.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    async function submit() {
        if (!totalHours) return;
        setLoading(true);
        try {
            const res  = await authFetch(`${API}/admin/subscriptions/${sub.id}/extend`, {
                method: 'POST',
                body: JSON.stringify({ extraDays: Number(days || 0), extraHours: Number(hours || 0), note })
            });
            const data = await res.json();
            if (data.success) {
                addToast({ title: '✅ تم التمديد', description: `انتهاء جديد: ${newExpiry}`, type: 'success' });
                onSave();
            } else {
                addToast({ title: 'خطأ', description: data.error, type: 'error' });
            }
        } finally { setLoading(false); }
    }

    return (
        <ModalWrapper title="تمديد الاشتراك" icon={<Calendar className="w-5 h-5"/>} onClose={onClose}>
            <div className="mb-4 p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                <p className="text-sm font-medium">{sub.full_name || sub.username}</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{sub.planLabel}</p>
                {sub.expires_at && (
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        الانتهاء الحالي: {new Date(sub.expires_at).toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </p>
                )}
            </div>
            <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                    <Field label="أيام إضافية">
                        <input type="number" min="0" value={days} onChange={e => setDays(e.target.value)}
                            className="input" placeholder="0"/>
                    </Field>
                    <Field label="ساعات إضافية">
                        <input type="number" min="0" max="23" value={hours} onChange={e => setHours(e.target.value)}
                            className="input" placeholder="0"/>
                    </Field>
                </div>
                {totalHours > 0 && (
                    <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 text-sm">
                        <span className="text-green-400 font-medium">✅ الانتهاء الجديد: </span>
                        <span className="text-[var(--text-primary)]">{newExpiry}</span>
                    </div>
                )}
                <Field label="ملاحظة">
                    <input value={note} onChange={e => setNote(e.target.value)} className="input" placeholder="سبب التمديد..."/>
                </Field>
                <div className="flex gap-3 pt-1">
                    <button onClick={submit} disabled={loading || !totalHours}
                        className="flex-1 h-11 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                        {loading && <Loader2 className="w-4 h-4 animate-spin"/>} تأكيد التمديد
                    </button>
                    <button onClick={onClose} className="flex-1 h-11 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-all">
                        إلغاء
                    </button>
                </div>
            </div>
        </ModalWrapper>
    );
}

// ── Renewals Modal ────────────────────────────────────────────────────────────
function RenewalsModal({ sub, onClose }: { sub: Sub; onClose: () => void }) {
    const [renewals, setRenewals] = useState<any[]>([]);
    const [loading, setLoading]   = useState(true);

    useEffect(() => {
        authFetch(`${API}/admin/subscriptions/${sub.id}/renewals`)
            .then(r => r.json())
            .then(d => { if (d.success) setRenewals(d.renewals); })
            .finally(() => setLoading(false));
    }, [sub.id]);

    return (
        <ModalWrapper title="سجل التجديدات" icon={<History className="w-5 h-5"/>} onClose={onClose} wide>
            <div className="mb-3">
                <p className="text-sm font-medium">{sub.full_name || sub.username}</p>
                <p className="text-xs text-[var(--text-muted)]">{sub.planLabel}</p>
            </div>
            {loading ? (
                <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-[var(--brand-primary)]"/>
                </div>
            ) : renewals.length === 0 ? (
                <div className="text-center py-8 text-[var(--text-muted)]">
                    <History className="w-8 h-8 mx-auto mb-2 opacity-30"/>
                    <p>لا يوجد سجل تجديدات</p>
                </div>
            ) : (
                <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
                    {renewals.map(r => (
                        <div key={r.id} className="p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-[var(--brand-primary)]">+{r.extended_hours} ساعة</span>
                                <span className="text-xs text-[var(--text-muted)]">{new Date(r.created_at).toLocaleDateString('ar')}</span>
                            </div>
                            {r.note && <p className="text-xs text-[var(--text-muted)] mt-1">{r.note}</p>}
                            <p className="text-xs text-[var(--text-muted)] mt-0.5">بواسطة: {r.admin_username || '—'}</p>
                        </div>
                    ))}
                </div>
            )}
        </ModalWrapper>
    );
}

// ── Modal Wrapper ─────────────────────────────────────────────────────────────
function ModalWrapper({ title, icon, onClose, children, wide }: {
    title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={onClose}>
            <div
                className={`w-full ${wide ? 'max-w-lg' : 'max-w-md'} bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-2xl shadow-[var(--shadow-elevated)] animate-scale-in`}
                onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
                    <div className="flex items-center gap-2">
                        <span className="text-[var(--brand-primary)]">{icon}</span>
                        <h3 className="font-bold text-lg">{title}</h3>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] transition-colors">
                        <X className="w-4 h-4"/>
                    </button>
                </div>
                <div className="p-6">{children}</div>
            </div>
        </div>
    );
}

// ── Form Field ────────────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[var(--text-secondary)]">{label}</label>
            {children}
        </div>
    );
}

// ── Action Button ─────────────────────────────────────────────────────────────
function ActionBtn({ onClick, title, children, variant = 'default', loading: btnLoading }: {
    onClick: () => void; title: string; children: React.ReactNode;
    variant?: 'default' | 'danger' | 'success' | 'warning';
    loading?: boolean;
}) {
    const colors = {
        default: 'hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
        danger:  'hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400',
        success: 'hover:bg-green-500/10 text-[var(--text-muted)] hover:text-green-400',
        warning: 'hover:bg-orange-500/10 text-[var(--text-muted)] hover:text-orange-400',
    };
    return (
        <button onClick={onClick} title={title} disabled={btnLoading}
            className={`p-1.5 rounded-lg transition-colors disabled:opacity-40 ${colors[variant]}`}>
            {btnLoading ? <Loader2 className="w-4 h-4 animate-spin"/> : children}
        </button>
    );
}

// ── Stats Section ─────────────────────────────────────────────────────────────
function StatsSection({ stats, loading }: { stats: Stats | null; loading: boolean }) {
    if (loading) return (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 h-20 animate-pulse"/>
            ))}
        </div>
    );
    if (!stats) return null;
    return (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard icon={<CreditCard className="w-5 h-5 text-[var(--brand-primary)]"/>}
                label="الإجمالي" value={stats.total}
                color="bg-[var(--brand-primary)]/10"/>
            <StatCard icon={<CheckCircle className="w-5 h-5 text-green-400"/>}
                label="نشط" value={stats.active}
                color="bg-green-500/10"/>
            <StatCard icon={<AlertTriangle className="w-5 h-5 text-orange-400"/>}
                label="ينتهي قريباً" value={stats.expiringSoon}
                sub="خلال 7 أيام" color="bg-orange-500/10"/>
            <StatCard icon={<XCircle className="w-5 h-5 text-red-400"/>}
                label="منتهي" value={stats.expired}
                color="bg-red-500/10"/>
            <StatCard icon={<Snowflake className="w-5 h-5 text-sky-400"/>}
                label="مجمّد" value={stats.frozen}
                color="bg-sky-500/10"/>
            <StatCard icon={<Infinity className="w-5 h-5 text-violet-400"/>}
                label="مدى الحياة" value={stats.lifetime}
                color="bg-violet-500/10"/>
        </div>
    );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function SubscriptionsView() {
    const [subs, setSubs]           = useState<Sub[]>([]);
    const [total, setTotal]         = useState(0);
    const [loading, setLoading]     = useState(true);
    const [filterStatus, setFilter] = useState('');
    const [filterPlan, setFilterP]  = useState('');
    const [search, setSearch]       = useState('');
    const [debouncedSearch, setDS]  = useState('');
    const [page, setPage]           = useState(1);
    const [plans, setPlans]         = useState<Plan[]>([]);
    const [stats, setStats]         = useState<Stats | null>(null);
    const [statsLoading, setSL]     = useState(true);
    const [showCreate, setCreate]   = useState(false);
    const [extendSub, setExtend]    = useState<Sub | null>(null);
    const [renewalsSub, setRenewals] = useState<Sub | null>(null);
    const [actionLoading, setActionL] = useState<string>('');
    const { addToast } = useToast();
    const searchTimer = useRef<ReturnType<typeof setTimeout>>();
    const LIMIT = 20;

    // Debounce search
    useEffect(() => {
        clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => { setDS(search); setPage(1); }, 400);
    }, [search]);

    // Load plans
    useEffect(() => {
        authFetch(`${API}/admin/plans`).then(r => r.json()).then(d => { if (d.success) setPlans(d.plans); });
    }, []);

    // Load stats
    const loadStats = useCallback(() => {
        setSL(true);
        authFetch(`${API}/admin/subscriptions/stats`)
            .then(r => r.json())
            .then(d => { if (d.success) setStats(d.stats); })
            .finally(() => setSL(false));
    }, []);

    useEffect(() => { loadStats(); }, [loadStats]);

    // Load subscriptions
    const load = useCallback(async () => {
        setLoading(true);
        try {
            const q = new URLSearchParams({
                status: filterStatus,
                planType: filterPlan,
                search: debouncedSearch,
                page: String(page),
                limit: String(LIMIT)
            });
            const res = await authFetch(`${API}/admin/subscriptions?${q}`);
            const d   = await res.json();
            if (d.success) { setSubs(d.subscriptions); setTotal(d.total); }
        } finally { setLoading(false); }
    }, [filterStatus, filterPlan, debouncedSearch, page]);

    useEffect(() => { load(); }, [load]);

    const reload = () => { load(); loadStats(); };

    // ── Actions ───────────────────────────────────────────────────────────────
    async function cancelSub(id: string) {
        if (!confirm('هل تريد إلغاء هذا الاشتراك؟')) return;
        setActionL(id + '_cancel');
        const res  = await authFetch(`${API}/admin/subscriptions/${id}`, { method: 'DELETE' });
        const data = await res.json();
        setActionL('');
        if (data.success) { addToast({ title: '✅ تم', description: 'تم إلغاء الاشتراك', type: 'success' }); reload(); }
        else addToast({ title: 'خطأ', description: data.error, type: 'error' });
    }

    async function freezeSub(id: string) {
        setActionL(id + '_freeze');
        const res  = await authFetch(`${API}/admin/subscriptions/${id}/freeze`, { method: 'PATCH', body: '{}' });
        const data = await res.json();
        setActionL('');
        if (data.success) { addToast({ title: '🧊 تم', description: 'تم تجميد الاشتراك', type: 'success' }); reload(); }
        else addToast({ title: 'خطأ', description: data.error, type: 'error' });
    }

    async function activateSub(id: string) {
        setActionL(id + '_activate');
        const res  = await authFetch(`${API}/admin/subscriptions/${id}/activate`, { method: 'PATCH', body: '{}' });
        const data = await res.json();
        setActionL('');
        if (data.success) { addToast({ title: '✅ تم', description: 'تم تفعيل الاشتراك', type: 'success' }); reload(); }
        else addToast({ title: 'خطأ', description: data.error, type: 'error' });
    }

    async function deleteSub(id: string) {
        if (!confirm('⚠️ سيتم حذف الاشتراك نهائياً. هل أنت متأكد؟')) return;
        setActionL(id + '_delete');
        const res  = await authFetch(`${API}/admin/subscriptions/${id}/permanent`, { method: 'DELETE' });
        const data = await res.json();
        setActionL('');
        if (data.success) { addToast({ title: '🗑️ تم', description: 'تم حذف الاشتراك نهائياً', type: 'success' }); reload(); }
        else addToast({ title: 'خطأ', description: data.error, type: 'error' });
    }

    async function exportCSV() {
        window.open(`${API}/admin/subscriptions/export`, '_blank');
    }

    const pages = Math.ceil(total / LIMIT);

    return (
        <div className="flex flex-col gap-6 animate-fade-in">

            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <CreditCard className="w-6 h-6 text-[var(--brand-primary)]"/>
                        إدارة الاشتراكات
                    </h1>
                    <p className="text-[var(--text-muted)] text-sm mt-1">{total} اشتراك إجمالاً</p>
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={exportCSV}
                        className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-all text-sm">
                        <Download className="w-4 h-4"/> تصدير CSV
                    </button>
                    <button onClick={() => setCreate(true)}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all shadow-[var(--shadow-glow)]">
                        <Plus className="w-4 h-4"/> اشتراك جديد
                    </button>
                </div>
            </div>

            {/* Stats */}
            <StatsSection stats={stats} loading={statsLoading}/>

            {/* Filters */}
            <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4">
                <div className="flex flex-wrap gap-3 items-center">
                    {/* Search */}
                    <div className="relative flex-1 min-w-52">
                        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]"/>
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="بحث بالاسم أو المستخدم..."
                            className="input pr-9 w-full"
                        />
                    </div>
                    {/* Status Filter */}
                    <select value={filterStatus} onChange={e => { setFilter(e.target.value); setPage(1); }}
                        className="input w-44">
                        {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {/* Plan Filter */}
                    <select value={filterPlan} onChange={e => { setFilterP(e.target.value); setPage(1); }}
                        className="input w-48">
                        <option value="">كل الخطط</option>
                        {plans.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                    {/* Refresh */}
                    <button onClick={reload}
                        className="p-2.5 rounded-xl border border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-colors">
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}/>
                    </button>
                </div>
            </div>

            {/* Table */}
            <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-[var(--border-default)] bg-[var(--bg-elevated)]">
                                {['المستخدم', 'الخطة', 'بداية', 'انتهاء', 'المتبقي', 'الحالة', 'إجراءات'].map(h => (
                                    <th key={h} className="px-4 py-3 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider whitespace-nowrap">{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                Array.from({ length: 5 }).map((_, i) => (
                                    <tr key={i} className="border-b border-[var(--border-default)]">
                                        {Array.from({ length: 7 }).map((_, j) => (
                                            <td key={j} className="px-4 py-3">
                                                <div className="h-4 bg-[var(--bg-elevated)] rounded animate-pulse"/>
                                            </td>
                                        ))}
                                    </tr>
                                ))
                            ) : subs.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-16 text-center text-[var(--text-muted)]">
                                        <CreditCard className="w-12 h-12 mx-auto mb-3 opacity-20"/>
                                        <p className="font-medium">لا توجد اشتراكات</p>
                                        <p className="text-sm mt-1">جرّب تغيير فلاتر البحث</p>
                                    </td>
                                </tr>
                            ) : subs.map(s => (
                                <tr key={s.id} className="border-b border-[var(--border-default)] hover:bg-[var(--bg-elevated)]/40 transition-colors">
                                    {/* المستخدم */}
                                    <td className="px-4 py-3">
                                        <p className="font-medium text-sm">{s.full_name || s.username}</p>
                                        <p className="text-xs text-[var(--text-muted)] dir-ltr">@{s.username}</p>
                                    </td>
                                    {/* الخطة */}
                                    <td className="px-4 py-3">
                                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-secondary)]">
                                            {s.planLabel}
                                        </span>
                                    </td>
                                    {/* بداية */}
                                    <td className="px-4 py-3 text-xs text-[var(--text-muted)] whitespace-nowrap">
                                        {s.started_at ? new Date(s.started_at).toLocaleDateString('ar') : '—'}
                                    </td>
                                    {/* انتهاء */}
                                    <td className="px-4 py-3 text-xs text-[var(--text-muted)] whitespace-nowrap">
                                        {s.expires_at ? new Date(s.expires_at).toLocaleDateString('ar') : '♾️ دائم'}
                                    </td>
                                    {/* المتبقي */}
                                    <td className="px-4 py-3">
                                        <StatusBadge sub={s}/>
                                    </td>
                                    {/* الحالة */}
                                    <td className="px-4 py-3">
                                        <span className={`text-xs px-2.5 py-1 rounded-full font-medium whitespace-nowrap
                                            ${s.status === 'active' && !s.isExpired ? 'bg-green-500/15 text-green-400'
                                            : s.status === 'frozen' ? 'bg-sky-500/15 text-sky-400'
                                            : 'bg-red-500/15 text-red-400'}`}>
                                            {s.status === 'active' && !s.isExpired ? '● نشط'
                                            : s.status === 'frozen' ? '❄ مجمّد'
                                            : '✕ منتهي'}
                                        </span>
                                    </td>
                                    {/* إجراءات */}
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-0.5">
                                            {/* تمديد */}
                                            <ActionBtn onClick={() => setExtend(s)} title="تمديد الاشتراك" variant="success">
                                                <Calendar className="w-4 h-4"/>
                                            </ActionBtn>
                                            {/* تجميد / تفعيل */}
                                            {s.status === 'frozen' ? (
                                                <ActionBtn onClick={() => activateSub(s.id)} title="تفعيل الاشتراك"
                                                    variant="success" loading={actionLoading === s.id + '_activate'}>
                                                    <Play className="w-4 h-4"/>
                                                </ActionBtn>
                                            ) : s.status === 'active' && !s.isExpired ? (
                                                <ActionBtn onClick={() => freezeSub(s.id)} title="تجميد الاشتراك"
                                                    variant="warning" loading={actionLoading === s.id + '_freeze'}>
                                                    <Snowflake className="w-4 h-4"/>
                                                </ActionBtn>
                                            ) : null}
                                            {/* سجل التجديدات */}
                                            <ActionBtn onClick={() => setRenewals(s)} title="سجل التجديدات">
                                                <History className="w-4 h-4"/>
                                            </ActionBtn>
                                            {/* إلغاء */}
                                            {s.status === 'active' && (
                                                <ActionBtn onClick={() => cancelSub(s.id)} title="إلغاء الاشتراك"
                                                    variant="danger" loading={actionLoading === s.id + '_cancel'}>
                                                    <XCircle className="w-4 h-4"/>
                                                </ActionBtn>
                                            )}
                                            {/* حذف نهائي */}
                                            <ActionBtn onClick={() => deleteSub(s.id)} title="حذف نهائي"
                                                variant="danger" loading={actionLoading === s.id + '_delete'}>
                                                <Trash2 className="w-4 h-4"/>
                                            </ActionBtn>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Pagination */}
                {pages > 1 && (
                    <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border-default)]">
                        <p className="text-sm text-[var(--text-muted)]">
                            صفحة {page} من {pages} ({total} إجمالاً)
                        </p>
                        <div className="flex gap-2">
                            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                                className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--border-strong)] disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">
                                <ChevronRight className="w-4 h-4"/> السابق
                            </button>
                            <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}
                                className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--border-strong)] disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">
                                التالي <ChevronLeft className="w-4 h-4"/>
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Modals */}
            {showCreate  && <CreateModal plans={plans} onClose={() => setCreate(false)} onSave={() => { setCreate(false); reload(); }}/>}
            {extendSub   && <ExtendModal sub={extendSub} onClose={() => setExtend(null)} onSave={() => { setExtend(null); reload(); }}/>}
            {renewalsSub && <RenewalsModal sub={renewalsSub} onClose={() => setRenewals(null)}/>}
        </div>
    );
}
