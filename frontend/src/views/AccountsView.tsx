import React, { useState, useEffect, useCallback } from 'react';
import {
  Search, Plus, Smartphone, Trash2, Link as LinkIcon, AlertCircle,
  RotateCcw, Play, Square, RefreshCw, ChevronDown, Activity,
  Megaphone, Users, Eye, Ban, Settings, FileText, Wifi, WifiOff,
  BarChart2, Clock, MessageSquare, X
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/ToastProvider';
import { API, authFetch } from '@/utils/api';
import { cn } from '@/utils/cn';
import { ConnectionMethodModal } from '@/components/ConnectionMethodModal';

const SOCKET_URL = API.replace('/api/v1', '');

// ── تعريف الأدوار ─────────────────────────────────────────────────────────────
const ROLES = [
  {
    id: 'publisher',
    label: 'ناشر',
    icon: Megaphone,
    color: 'text-blue-400',
    bg: 'bg-blue-500/15',
    border: 'border-blue-500/30',
    barColor: 'bg-blue-500',
    description: 'ينشر الإعلانات في المجموعات',
  },
  {
    id: 'searcher',
    label: 'باحث',
    icon: Search,
    color: 'text-purple-400',
    bg: 'bg-purple-500/15',
    border: 'border-purple-500/30',
    barColor: 'bg-purple-500',
    description: 'يبحث ويفهرس روابط المجموعات',
  },
  {
    id: 'joiner',
    label: 'منضم',
    icon: Users,
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/15',
    border: 'border-yellow-500/30',
    barColor: 'bg-yellow-500',
    description: 'ينضم للمجموعات تلقائياً',
  },
  {
    id: 'monitor',
    label: 'مراقب',
    icon: Eye,
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/15',
    border: 'border-cyan-500/30',
    barColor: 'bg-cyan-500',
    description: 'يراقب المجموعات ويكتشف الروابط',
  },
  {
    id: 'stopped',
    label: 'متوقف',
    icon: Ban,
    color: 'text-[var(--text-muted)]',
    bg: 'bg-[var(--bg-elevated)]',
    border: 'border-[var(--border-default)]',
    barColor: 'bg-gray-600',
    description: 'موقوف مؤقتاً',
  },
];

function getRoleInfo(roleId: string) {
  return ROLES.find(r => r.id === roleId) || ROLES[ROLES.length - 1];
}

// ── بطاقة الملخص العلوي ───────────────────────────────────────────────────────
function SummaryCard({ label, value, icon: Icon, color }: any) {
  return (
    <div className="flex items-center gap-3 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl p-3">
      <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center', color.replace('text-', 'bg-').replace('400', '500/15'))}>
        <Icon className={cn('w-4 h-4', color)} />
      </div>
      <div>
        <p className="text-xs text-[var(--text-muted)]">{label}</p>
        <p className="text-lg font-bold text-[var(--text-primary)]">{value}</p>
      </div>
    </div>
  );
}

// ── بطاقة الحساب ─────────────────────────────────────────────────────────────
function AccountCard({
  account,
  selected,
  onSelect,
  onConnect,
  onReset,
  onDelete,
  onStart,
  onStop,
  onRestart,
  onRoleChange,
  onTest,
  onViewLogs,
}: any) {
  const [showRoleMenu, setShowRoleMenu] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const role = getRoleInfo(account.role);
  const RoleIcon = role.icon;
  const isConnected = account.status === 'connected';
  const isRunning   = account.task_status === 'running';

  const action = async (fn: () => Promise<void>, key: string) => {
    setLoadingAction(key);
    try { await fn(); } finally { setLoadingAction(null); }
  };

  return (
    <Card className={cn(
      'relative overflow-hidden flex flex-col group transition-all duration-200',
      selected ? 'ring-2 ring-[var(--brand-primary)] shadow-lg shadow-[var(--brand-primary)]/10' : 'hover:border-[var(--border-strong)]'
    )}>
      {/* شريط الدور (أعلى البطاقة) */}
      <div className={cn('absolute top-0 left-0 w-full h-1', role.barColor)} />

      <CardContent className="p-4 flex flex-col gap-3 pt-5">
        {/* رأس البطاقة */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <div className="w-10 h-10 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center border border-[var(--border-strong)]">
                <Smartphone className="w-5 h-5 text-[var(--text-primary)]" />
              </div>
              {/* مؤشر الاتصال */}
              <span className={cn(
                'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[var(--bg-surface)]',
                isConnected ? 'bg-green-500' : 'bg-red-500'
              )} />
            </div>
            <div>
              <h3 className="font-bold text-[var(--text-primary)] text-sm leading-tight">{account.name}</h3>
              <p className="text-xs text-[var(--text-muted)] dir-ltr">
                {account.phone_number || 'لا يوجد رقم'}
              </p>
            </div>
          </div>

          {/* شارة الدور */}
          <div className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium border',
            role.bg, role.color, role.border
          )}>
            <RoleIcon className="w-3 h-3" />
            <span>{role.label}</span>
            {isRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            )}
          </div>
        </div>

        {/* إحصائيات سريعة */}
        <div className="grid grid-cols-3 gap-1.5 bg-[var(--bg-app)] rounded-lg p-2 text-center">
          <div>
            <p className="text-[10px] text-[var(--text-muted)]">الرسائل</p>
            <p className="text-xs font-bold text-[var(--text-primary)]">
              {account.messages_sent_today || 0}
            </p>
          </div>
          <div className="border-r border-l border-[var(--border-default)]">
            <p className="text-[10px] text-[var(--text-muted)]">الحالة</p>
            <p className={cn('text-xs font-bold', isConnected ? 'text-green-400' : 'text-red-400')}>
              {isConnected ? 'متصل' : 'مفصول'}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-[var(--text-muted)]">نوع الربط</p>
            <p className="text-[10px] font-medium text-[var(--text-muted)] truncate">
              {account.connection_type === 'business_api' ? '🏢 API'
               : account.connection_type === 'pairing_code' ? '#️⃣ Pair'
               : '📱 QR'}
            </p>
          </div>
        </div>

        {/* أزرار التحكم الرئيسية */}
        <div className="flex gap-1.5">
          <Button
            variant={selected ? 'default' : 'outline'}
            className="flex-1 text-xs h-8"
            onClick={() => onSelect(account.id)}
          >
            {selected ? 'مُحدد ✓' : 'تحديد'}
          </Button>

          {/* تشغيل/إيقاف المهام */}
          {isConnected && account.role !== 'stopped' && (
            isRunning ? (
              <Button
                variant="outline"
                className="px-2 h-8 text-orange-400 hover:bg-orange-400/10 hover:text-orange-400 border-orange-400/30"
                onClick={() => action(() => onStop(account.id), 'stop')}
                disabled={loadingAction === 'stop'}
                title="إيقاف المهام"
              >
                {loadingAction === 'stop'
                  ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  : <Square className="w-3.5 h-3.5" />
                }
              </Button>
            ) : (
              <Button
                variant="outline"
                className="px-2 h-8 text-green-400 hover:bg-green-400/10 hover:text-green-400 border-green-400/30"
                onClick={() => action(() => onStart(account.id), 'start')}
                disabled={loadingAction === 'start'}
                title="تشغيل المهام"
              >
                {loadingAction === 'start'
                  ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  : <Play className="w-3.5 h-3.5" />
                }
              </Button>
            )
          )}

          {/* إعادة تشغيل */}
          {isConnected && (
            <Button
              variant="outline"
              className="px-2 h-8 hover:bg-blue-400/10 hover:text-blue-400"
              onClick={() => action(() => onRestart(account.id), 'restart')}
              disabled={loadingAction === 'restart'}
              title="إعادة تشغيل"
            >
              <RotateCcw className={cn('w-3.5 h-3.5', loadingAction === 'restart' ? 'animate-spin' : '')} />
            </Button>
          )}
        </div>

        {/* أزرار ثانوية */}
        <div className="flex gap-1.5">
          {/* تغيير الدور */}
          <div className="relative flex-1">
            <Button
              variant="outline"
              className="w-full text-xs h-7 gap-1 justify-between"
              onClick={() => setShowRoleMenu(!showRoleMenu)}
            >
              <span className="flex items-center gap-1">
                <Settings className="w-3 h-3" />
                <span>الدور</span>
              </span>
              <ChevronDown className={cn('w-3 h-3 transition-transform', showRoleMenu ? 'rotate-180' : '')} />
            </Button>

            {showRoleMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-[var(--bg-elevated)] border border-[var(--border-strong)] rounded-lg overflow-hidden z-50 shadow-xl">
                {ROLES.map(r => {
                  const RI = r.icon;
                  return (
                    <button
                      key={r.id}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--bg-surface)] transition-colors',
                        account.role === r.id ? 'bg-[var(--bg-surface)]' : ''
                      )}
                      onClick={() => { onRoleChange(account.id, r.id); setShowRoleMenu(false); }}
                    >
                      <RI className={cn('w-3 h-3', r.color)} />
                      <span className="text-[var(--text-primary)]">{r.label}</span>
                      <span className="text-[var(--text-muted)] mr-auto">{r.description}</span>
                      {account.role === r.id && <span className="text-green-400">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ربط واتساب */}
          {!isConnected && (
            <Button
              variant="outline"
              className="px-2 h-7 hover:bg-green-400/10 hover:text-green-400"
              onClick={() => onConnect(account.id)}
              title="ربط واتساب"
            >
              <Wifi className="w-3 h-3" />
            </Button>
          )}

          {/* إعادة تهيئة الجلسة */}
          {!isConnected && (
            <Button
              variant="outline"
              className="px-2 h-7 hover:bg-yellow-400/10 hover:text-yellow-400"
              onClick={() => onReset(account.id)}
              title="إعادة تهيئة QR"
            >
              <RotateCcw className="w-3 h-3" />
            </Button>
          )}

          {/* اختبار الاتصال */}
          <Button
            variant="outline"
            className="px-2 h-7 hover:bg-cyan-400/10 hover:text-cyan-400"
            onClick={() => onTest(account.id)}
            title="اختبار الاتصال"
          >
            <Activity className="w-3 h-3" />
          </Button>

          {/* السجلات */}
          <Button
            variant="outline"
            className="px-2 h-7 hover:bg-purple-400/10 hover:text-purple-400"
            onClick={() => onViewLogs(account.id, account.name)}
            title="عرض السجلات"
          >
            <FileText className="w-3 h-3" />
          </Button>

          {/* حذف */}
          <Button
            variant="outline"
            className="px-2 h-7 text-red-500 hover:bg-red-500/10 hover:text-red-500"
            onClick={() => onDelete(account.id)}
            title="حذف الحساب"
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>

        {/* آخر نشاط */}
        {account.last_activity_at && (
          <p className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {new Date(account.last_activity_at).toLocaleString('ar')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── نافذة سجلات الحساب ───────────────────────────────────────────────────────
function LogsModal({ accountId, accountName, onClose }: any) {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch(`${API}/accounts/${accountId}/logs?limit=50`)
      .then(r => r.json())
      .then(d => setLogs(d.logs || []))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-4 h-4" />
            سجلات: {accountName}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto space-y-1">
          {loading ? (
            <div className="text-center text-[var(--text-muted)] py-8">جاري التحميل...</div>
          ) : logs.length === 0 ? (
            <div className="text-center text-[var(--text-muted)] py-8">لا توجد سجلات</div>
          ) : logs.map((log, i) => (
            <div key={i} className={cn(
              'flex items-start gap-2 px-3 py-2 rounded-lg text-xs',
              log.level === 'error' ? 'bg-red-500/10 text-red-400' :
              log.level === 'warn'  ? 'bg-yellow-500/10 text-yellow-400' :
              'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
            )}>
              <span className="text-[var(--text-muted)] whitespace-nowrap">
                {new Date(log.created_at).toLocaleTimeString('ar')}
              </span>
              <span>{log.message}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── المكوّن الرئيسي ───────────────────────────────────────────────────────────
interface AccountsViewProps {
  accounts: any[];
  loading: boolean;
  fetchAccounts: () => void;
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;
}

export default function AccountsView({
  accounts, loading, fetchAccounts, selectedAccountId, setSelectedAccountId
}: AccountsViewProps) {
  const [search, setSearch]           = useState('');
  const [filterRole, setFilterRole]   = useState('all');
  const [isAddOpen, setIsAddOpen]     = useState(false);
  const [newName, setNewName]         = useState('');
  const [summary, setSummary]         = useState<any>({});
  const [logsModal, setLogsModal]     = useState<{ id: string; name: string } | null>(null);
  // ── نافذة طرق الربط ────────────────────────────────────────────────────────
  const [connectModal, setConnectModal] = useState<{ id: string; name: string } | null>(null);
  const { addToast } = useToast();

  // جلب الملخص
  const fetchSummary = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/accounts/summary`);
      const d = await r.json();
      if (d.success) setSummary(d.summary);
    } catch {}
  }, []);

  useEffect(() => {
    fetchSummary();
    const iv = setInterval(fetchSummary, 30000);
    return () => clearInterval(iv);
  }, [fetchSummary]);

  // تصفية الحسابات
  const filtered = accounts.filter(a => {
    const matchSearch = a.name.toLowerCase().includes(search.toLowerCase())
      || (a.phone_number || '').includes(search);
    const matchRole = filterRole === 'all' || a.role === filterRole;
    return matchSearch && matchRole;
  });

  // ── إضافة حساب ────────────────────────────────────────────────────────────
  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      const res  = await authFetch(`${API}/accounts`, {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        addToast({ title: 'تم الإنشاء', description: 'اختر طريقة ربط الحساب', type: 'success' });
        setIsAddOpen(false);
        setNewName('');
        fetchAccounts();
        fetchSummary();
        // افتح نافذة طرق الربط مباشرة
        setConnectModal({ id: data.account.id, name: data.account.name });
      } else {
        addToast({ title: 'خطأ', description: data.error || 'فشل الإنشاء', type: 'error' });
      }
    } catch {
      addToast({ title: 'خطأ', description: 'فشل إنشاء الحساب', type: 'error' });
    }
  };

  // ── فتح نافذة طرق الربط ───────────────────────────────────────────────────
  const handleConnect = (id: string) => {
    const account = accounts.find(a => a.id === id);
    setConnectModal({ id, name: account?.name || id });
  };

  // ── إعادة تهيئة الجلسة (QR جديد) ─────────────────────────────────────────
  const handleReset = async (id: string) => {
    try {
      await authFetch(`${API}/accounts/${id}/reset`, { method: 'POST' });
      addToast({ title: 'جارٍ الإعادة', description: 'اختر طريقة الربط من جديد', type: 'success' });
      // افتح نافذة طرق الربط بعد الإعادة
      const account = accounts.find(a => a.id === id);
      setConnectModal({ id, name: account?.name || id });
    } catch {
      addToast({ title: 'خطأ', description: 'فشلت إعادة تهيئة الجلسة', type: 'error' });
    }
  };

  // ── حذف الحساب ────────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذا الحساب؟ لا يمكن التراجع.')) return;
    try {
      await authFetch(`${API}/accounts/${id}`, { method: 'DELETE' });
      addToast({ title: 'تم الحذف', type: 'success' });
      fetchAccounts();
      fetchSummary();
      if (selectedAccountId === id) setSelectedAccountId(null);
    } catch {
      addToast({ title: 'خطأ', description: 'فشل الحذف', type: 'error' });
    }
  };

  // ── تغيير الدور ───────────────────────────────────────────────────────────
  const handleRoleChange = async (id: string, role: string) => {
    try {
      const res  = await authFetch(`${API}/accounts/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (data.success) {
        addToast({ title: 'تم التغيير', description: data.message, type: 'success' });
        fetchAccounts();
        fetchSummary();
      } else {
        addToast({ title: 'خطأ', description: data.error, type: 'error' });
      }
    } catch {
      addToast({ title: 'خطأ', description: 'فشل تغيير الدور', type: 'error' });
    }
  };

  // ── تشغيل المهام ──────────────────────────────────────────────────────────
  const handleStart = async (id: string) => {
    const res  = await authFetch(`${API}/accounts/${id}/start`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      addToast({ title: 'تم التشغيل ✓', description: data.message, type: 'success' });
      fetchAccounts();
    } else {
      addToast({ title: 'خطأ', description: data.error, type: 'error' });
    }
  };

  // ── إيقاف المهام ──────────────────────────────────────────────────────────
  const handleStop = async (id: string) => {
    const res  = await authFetch(`${API}/accounts/${id}/stop`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      addToast({ title: 'تم الإيقاف', description: data.message, type: 'success' });
      fetchAccounts();
    }
  };

  // ── إعادة التشغيل ─────────────────────────────────────────────────────────
  const handleRestart = async (id: string) => {
    const res  = await authFetch(`${API}/accounts/${id}/restart`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      addToast({ title: 'تمت الإعادة', description: data.message, type: 'success' });
      fetchAccounts();
    }
  };

  // ── اختبار الاتصال ────────────────────────────────────────────────────────
  const handleTest = async (id: string) => {
    const res  = await authFetch(`${API}/accounts/${id}/test`, { method: 'POST' });
    const data = await res.json();
    addToast({
      title: data.connected ? 'الاتصال سليم ✓' : 'الاتصال منقطع',
      description: data.connected
        ? `المستخدم: ${data.sessionUser || 'متصل'}`
        : 'يرجى إعادة ربط الحساب',
      type: data.connected ? 'success' : 'error',
    });
  };

  // ── عرض السجلات ───────────────────────────────────────────────────────────
  const handleViewLogs = (id: string, name: string) => {
    setLogsModal({ id, name });
  };

  return (
    <div className="flex flex-col gap-5 animate-fade-in h-full">

      {/* ── ملخص الأدوار ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <SummaryCard label="الكلي"    value={summary.total      || 0} icon={Smartphone}   color="text-[var(--text-primary)]" />
        <SummaryCard label="متصل"     value={summary.connected  || 0} icon={Wifi}          color="text-green-400" />
        <SummaryCard label="ناشرون"   value={summary.publishers || 0} icon={Megaphone}     color="text-blue-400" />
        <SummaryCard label="باحثون"   value={summary.searchers  || 0} icon={Search}        color="text-purple-400" />
        <SummaryCard label="منضمون"   value={summary.joiners    || 0} icon={Users}         color="text-yellow-400" />
        <SummaryCard label="مراقبون"  value={summary.monitors   || 0} icon={Eye}           color="text-cyan-400" />
      </div>

      {/* ── شريط الأدوات ─────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">الحسابات</h1>
          <p className="text-xs text-[var(--text-secondary)]">إدارة حسابات واتساب وأدوارها المستقلة</p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-52">
            <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              className="input pr-8 text-sm h-9"
              placeholder="بحث عن حساب..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={() => setIsAddOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            <span>إضافة</span>
          </Button>
        </div>
      </div>

      {/* ── تبويبات الفلترة ──────────────────────────────────────────────── */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 flex-wrap">
        {[{ id: 'all', label: 'الكل', icon: BarChart2 }, ...ROLES].map(r => {
          const RI = (r as any).icon;
          const roleInfo = ROLES.find(x => x.id === r.id);
          return (
            <button
              key={r.id}
              onClick={() => setFilterRole(r.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all whitespace-nowrap',
                filterRole === r.id
                  ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                  : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[var(--border-strong)]'
              )}
            >
              <RI className="w-3 h-3" />
              <span>{r.label}</span>
              {r.id !== 'all' && (
                <span className="opacity-60">
                  ({accounts.filter(a => a.role === r.id).length})
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── قائمة الحسابات ──────────────────────────────────────────────── */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3].map(i => <Skeleton key={i} className="h-56 w-full rounded-xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-[var(--border-default)] rounded-2xl p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--text-muted)] mb-4">
            <Smartphone className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold text-[var(--text-primary)]">
            {filterRole === 'all' ? 'لا توجد حسابات' : `لا توجد حسابات بدور "${getRoleInfo(filterRole).label}"`}
          </h3>
          <p className="text-[var(--text-secondary)] max-w-sm mt-2 mb-6 text-sm">
            {filterRole === 'all'
              ? 'أضف حساباً جديداً لتبدأ في النشر والإدارة.'
              : 'قم بتعيين هذا الدور لحساب موجود أو أضف حساباً جديداً.'
            }
          </p>
          {filterRole === 'all' && (
            <Button onClick={() => setIsAddOpen(true)}>
              <Plus className="w-4 h-4" />
              إضافة حساب
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto pb-8">
          {filtered.map(account => (
            <AccountCard
              key={account.id}
              account={account}
              selected={selectedAccountId === account.id}
              onSelect={setSelectedAccountId}
              onConnect={handleConnect}
              onReset={handleReset}
              onDelete={handleDelete}
              onStart={handleStart}
              onStop={handleStop}
              onRestart={handleRestart}
              onRoleChange={handleRoleChange}
              onTest={handleTest}
              onViewLogs={handleViewLogs}
            />
          ))}
        </div>
      )}

      {/* ── نافذة إضافة حساب ─────────────────────────────────────────────── */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة حساب واتساب جديد</DialogTitle>
          </DialogHeader>
          <div className="py-4 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">اسم الحساب</label>
              <input
                className="input"
                placeholder="مثال: حساب النشر الأول"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div className="bg-[var(--bg-elevated)] rounded-lg p-3 text-xs text-[var(--text-muted)] border border-[var(--border-default)]">
              <p className="font-medium text-[var(--text-secondary)] mb-1">بعد الإضافة:</p>
              <p>• ستختار طريقة الربط بعد الإنشاء (QR / Pairing / Business API)</p>
              <p>• حدد دور الحساب (ناشر / باحث / منضم / مراقب)</p>
              <p>• اضغط تشغيل لبدء المهام التلقائية</p>
            </div>
            <Button
              onClick={handleAdd}
              disabled={!newName.trim()}
              className="w-full"
            >
              إنشاء ومتابعة
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── نافذة طرق الربط (QR / Pairing / Business API) ─────────────── */}
      {connectModal && (
        <ConnectionMethodModal
          accountId={connectModal.id}
          accountName={connectModal.name}
          open={!!connectModal}
          onClose={() => setConnectModal(null)}
          onConnected={() => {
            setConnectModal(null);
            fetchAccounts();
            fetchSummary();
          }}
          showToast={addToast}
        />
      )}

      {/* ── نافذة السجلات ────────────────────────────────────────────────── */}
      {logsModal && (
        <LogsModal
          accountId={logsModal.id}
          accountName={logsModal.name}
          onClose={() => setLogsModal(null)}
        />
      )}
    </div>
  );
}
