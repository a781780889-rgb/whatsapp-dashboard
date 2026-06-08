import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Shield, ShieldCheck, ShieldAlert, ShieldOff,
  Gauge, Users, Clock, AlertTriangle, Activity,
  Play, Square, RefreshCw, Trash2, ChevronDown,
  BarChart3, List, Settings, RotateCcw, Eye,
  CheckCircle, XCircle, ArrowRight, Zap, Timer,
  Ban, Wifi, TrendingUp, Filter, Download,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/ToastProvider';
import { API, authFetch } from '@/utils/api';
import { cn } from '@/utils/cn';

// ─── أنواع ──────────────────────────────────────────────────────────────────
interface ProtectionConfig {
  max_ops_per_hour: number;
  max_ops_per_day: number;
  min_delay_between_ops: number;
  max_delay_between_ops: number;
  distribution_mode: 'round_robin' | 'weighted' | 'priority' | 'least_busy';
  error_threshold: number;
  auto_disable_on_error: boolean;
  retry_enabled: boolean;
  max_retries: number;
  retry_base_delay: number;
  retry_max_delay: number;
  log_retention_days: number;
  is_active: boolean;
}

interface AccountState {
  id: string;
  phone_number: string;
  name: string;
  status: string;
  is_suspended: boolean;
  suspended_at: string | null;
  recent_errors: number;
}

interface SecurityLog {
  id: string;
  account_id: string;
  event_type: string;
  message: string;
  metadata: Record<string, any>;
  created_at: string;
}

interface LogSummary {
  event_type: string;
  last_hour: string;
  last_day: string;
  last_week: string;
  last_at: string;
}

// ─── ثوابت ──────────────────────────────────────────────────────────────────
const EVENT_LABELS: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  join_success:  { label: 'انضمام ناجح',     color: 'text-emerald-400',  icon: CheckCircle },
  join_failed:   { label: 'انضمام فاشل',     color: 'text-red-400',      icon: XCircle     },
  rate_limit:    { label: 'حد السرعة',        color: 'text-yellow-400',   icon: Gauge       },
  error:         { label: 'خطأ',              color: 'text-red-500',      icon: AlertTriangle },
  auto_disable:  { label: 'إيقاف تلقائي',   color: 'text-orange-400',   icon: ShieldOff   },
  resume:        { label: 'استئناف',         color: 'text-blue-400',     icon: Play        },
  retry:         { label: 'إعادة محاولة',   color: 'text-purple-400',   icon: RefreshCw   },
  config_change: { label: 'تغيير الإعدادات', color: 'text-cyan-400',     icon: Settings    },
};

const DIST_OPTIONS = [
  { value: 'round_robin', label: 'تناوبي (Round Robin)', desc: 'توزيع متساوٍ بالتناوب' },
  { value: 'weighted',    label: 'ذو أوزان (Weighted)',   desc: 'توزيع حسب أوزان الحسابات' },
  { value: 'priority',    label: 'بالأولوية (Priority)',  desc: 'الحساب ذو الأولوية الأعلى أولاً' },
  { value: 'least_busy',  label: 'الأقل إشغالاً',         desc: 'الحساب الأقل عملاً حالياً' },
];

// ─── مكوّن Slider مخصص ──────────────────────────────────────────────────────
function SliderInput({
  label, value, min, max, step = 1, unit = '',
  onChange, description,
}: {
  label: string; value: number; min: number; max: number;
  step?: number; unit?: string; onChange: (v: number) => void;
  description?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
        <span className="text-sm font-bold text-[var(--brand-primary)] bg-[var(--brand-primary)]/10 px-2 py-0.5 rounded-lg">
          {value}{unit}
        </span>
      </div>
      <div className="relative h-2 bg-[var(--bg-elevated)] rounded-full">
        <div
          className="absolute inset-y-0 right-0 bg-gradient-to-l from-[var(--brand-primary)] to-[var(--brand-secondary)] rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
          style={{ direction: 'ltr' }}
        />
      </div>
      <div className="flex justify-between text-xs text-[var(--text-muted)]">
        <span>{max}{unit}</span>
        <span>{description}</span>
        <span>{min}{unit}</span>
      </div>
    </div>
  );
}

// ─── مكوّن Toggle ────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, label, desc }: {
  checked: boolean; onChange: (v: boolean) => void;
  label: string; desc?: string;
}) {
  return (
    <div className="flex items-center justify-between p-3 bg-[var(--bg-elevated)] rounded-xl">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {desc && <p className="text-xs text-[var(--text-muted)] mt-0.5">{desc}</p>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          'relative w-12 h-6 rounded-full transition-all duration-300',
          checked ? 'bg-[var(--brand-primary)]' : 'bg-[var(--border-strong)]'
        )}
      >
        <span className={cn(
          'absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-300',
          checked ? 'right-1' : 'left-1'
        )} />
      </button>
    </div>
  );
}

// ─── الصفحة الرئيسية ─────────────────────────────────────────────────────────
export default function ProtectionView() {
  const { showToast } = useToast();

  // ── حالات التحميل والتبويب ──────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'overview' | 'config' | 'accounts' | 'logs'>('overview');
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);

  // ── بيانات ──────────────────────────────────────────────────────────────
  const [config, setConfig]             = useState<ProtectionConfig | null>(null);
  const [draftConfig, setDraftConfig]   = useState<ProtectionConfig | null>(null);
  const [accounts, setAccounts]         = useState<AccountState[]>([]);
  const [logs, setLogs]                 = useState<SecurityLog[]>([]);
  const [logTotal, setLogTotal]         = useState(0);
  const [logSummary, setLogSummary]     = useState<LogSummary[]>([]);
  const [suspendedCount, setSuspendedCount] = useState(0);
  const [logFilter, setLogFilter]       = useState('');
  const [logPage, setLogPage]           = useState(0);
  const [logEventFilter, setLogEventFilter] = useState('');
  const logsPerPage = 50;

  // ── جلب البيانات ─────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes, stateRes, summaryRes] = await Promise.all([
        authFetch(`${API}/protection/config`),
        authFetch(`${API}/protection/accounts/state`),
        authFetch(`${API}/protection/logs/summary`),
      ]);
      const [cfgData, stateData, summaryData] = await Promise.all([
        cfgRes.json(), stateRes.json(), summaryRes.json(),
      ]);
      if (cfgData.success) {
        setConfig(cfgData.config);
        setDraftConfig(cfgData.config);
      }
      if (stateData.success) setAccounts(stateData.accounts);
      if (summaryData.success) {
        setLogSummary(summaryData.summary);
        setSuspendedCount(summaryData.suspendedAccounts || 0);
      }
    } catch {
      showToast('فشل في جلب بيانات الحماية', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const fetchLogs = useCallback(async (page = 0, eventType = '') => {
    try {
      const params = new URLSearchParams({
        limit:  String(logsPerPage),
        offset: String(page * logsPerPage),
      });
      if (eventType) params.set('eventType', eventType);
      const res  = await authFetch(`${API}/protection/logs?${params}`);
      const data = await res.json();
      if (data.success) {
        setLogs(data.logs);
        setLogTotal(data.total);
        setLogPage(page);
      }
    } catch {
      showToast('فشل في جلب السجل الأمني', 'error');
    }
  }, [showToast]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => {
    if (activeTab === 'logs') fetchLogs(0, logEventFilter);
  }, [activeTab, logEventFilter, fetchLogs]);

  // ── حفظ الإعدادات ──────────────────────────────────────────────────────
  const saveConfig = async () => {
    if (!draftConfig) return;
    setSaving(true);
    try {
      const res  = await authFetch(`${API}/protection/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftConfig),
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        showToast('تم حفظ إعدادات الحماية', 'success');
      } else {
        showToast(data.error || 'فشل في الحفظ', 'error');
      }
    } catch {
      showToast('خطأ في الاتصال', 'error');
    } finally {
      setSaving(false);
    }
  };

  const resetConfig = async () => {
    if (!confirm('هل تريد إعادة ضبط جميع الإعدادات للقيم الافتراضية؟')) return;
    setSaving(true);
    try {
      const res  = await authFetch(`${API}/protection/config/reset`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        setDraftConfig(data.config);
        showToast('تم إعادة الضبط للافتراضي', 'success');
      }
    } catch {
      showToast('فشل في إعادة الضبط', 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── تعليق / استئناف الحسابات ────────────────────────────────────────────
  const toggleAccountSuspension = async (acc: AccountState) => {
    const endpoint = acc.is_suspended ? 'resume' : 'suspend';
    try {
      const res  = await authFetch(`${API}/protection/accounts/${acc.id}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: acc.is_suspended ? '' : 'يدوي' }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, 'success');
        fetchAll();
      }
    } catch {
      showToast('فشل في تغيير حالة الحساب', 'error');
    }
  };

  // ── حذف السجلات القديمة ─────────────────────────────────────────────────
  const clearOldLogs = async () => {
    if (!confirm('هل تريد حذف السجلات القديمة؟')) return;
    try {
      const res  = await authFetch(`${API}/protection/logs`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, 'success');
        fetchLogs(0, logEventFilter);
      }
    } catch {
      showToast('فشل في حذف السجلات', 'error');
    }
  };

  // ─── شريط التبويب ────────────────────────────────────────────────────────
  const TABS = [
    { id: 'overview',  label: 'نظرة عامة',  icon: Activity  },
    { id: 'config',    label: 'الإعدادات',  icon: Settings  },
    { id: 'accounts',  label: 'الحسابات',   icon: Users     },
    { id: 'logs',      label: 'السجل الأمني', icon: List    },
  ] as const;

  // ─── إحصاءات سريعة (بطاقات أعلى الصفحة) ────────────────────────────────
  const quickStats = [
    {
      label: 'الحماية',
      value: config?.is_active ? 'مُفعَّلة' : 'معطَّلة',
      icon: config?.is_active ? ShieldCheck : ShieldOff,
      color: config?.is_active ? 'text-emerald-400' : 'text-red-400',
      bg:    config?.is_active ? 'bg-emerald-500/10' : 'bg-red-500/10',
    },
    {
      label: 'حسابات موقوفة',
      value: suspendedCount,
      icon: Ban,
      color: suspendedCount > 0 ? 'text-orange-400' : 'text-[var(--text-muted)]',
      bg:    suspendedCount > 0 ? 'bg-orange-500/10' : 'bg-[var(--bg-elevated)]',
    },
    {
      label: 'أخطاء (24س)',
      value: logSummary.find(s => s.event_type === 'join_failed')?.last_day ?? '0',
      icon: XCircle,
      color: 'text-red-400',
      bg: 'bg-red-500/10',
    },
    {
      label: 'نجاحات (24س)',
      value: logSummary.find(s => s.event_type === 'join_success')?.last_day ?? '0',
      icon: CheckCircle,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'حد الساعة',
      value: config?.max_ops_per_hour ?? '—',
      icon: Gauge,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
    },
    {
      label: 'حد اليوم',
      value: config?.max_ops_per_day ?? '—',
      icon: TrendingUp,
      color: 'text-purple-400',
      bg: 'bg-purple-500/10',
    },
  ];

  if (loading) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-12 h-12 rounded-2xl bg-[var(--brand-primary)]/10 flex items-center justify-center mx-auto animate-pulse">
          <Shield className="w-6 h-6 text-[var(--brand-primary)]" />
        </div>
        <p className="text-[var(--text-muted)] text-sm">جاري تحميل نظام الحماية…</p>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden" dir="rtl">
      {/* ── رأس الصفحة ───────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)] shrink-0">
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-10 h-10 rounded-2xl flex items-center justify-center',
            config?.is_active ? 'bg-emerald-500/15' : 'bg-[var(--bg-elevated)]'
          )}>
            <Shield className={cn('w-5 h-5', config?.is_active ? 'text-emerald-400' : 'text-[var(--text-muted)]')} />
          </div>
          <div>
            <h1 className="text-lg font-bold">نظام الحماية المتقدم</h1>
            <p className="text-xs text-[var(--text-muted)]">
              مراقبة الأخطاء · تحديد السرعة · توزيع المهام · الإيقاف التلقائي
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={cn(
            'text-xs px-2.5 py-1 font-semibold border',
            config?.is_active
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
              : 'bg-red-500/10 text-red-400 border-red-500/30'
          )}>
            {config?.is_active ? '● نشط' : '○ معطَّل'}
          </Badge>
          <button
            onClick={fetchAll}
            className="p-2 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── تبويبات ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-6 pt-4 shrink-0 border-b border-[var(--border-default)] pb-0">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-xl transition-all border-b-2 -mb-px',
              activeTab === tab.id
                ? 'text-[var(--brand-primary)] border-[var(--brand-primary)] bg-[var(--brand-primary)]/5'
                : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
            )}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── المحتوى ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">

        {/* ════════════════════════════════════════════════
            تبويب 1: نظرة عامة
        ════════════════════════════════════════════════ */}
        {activeTab === 'overview' && (
          <>
            {/* بطاقات الإحصاءات */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {quickStats.map((s, i) => (
                <Card key={i} className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                  <CardContent className="p-4">
                    <div className={cn('w-8 h-8 rounded-xl flex items-center justify-center mb-2', s.bg)}>
                      <s.icon className={cn('w-4 h-4', s.color)} />
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mb-0.5">{s.label}</p>
                    <p className={cn('text-lg font-bold', s.color)}>{s.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* ملخص الأحداث */}
            <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
              <CardContent className="p-5">
                <h3 className="font-bold text-sm mb-4 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-[var(--brand-primary)]" />
                  ملخص الأحداث الأمنية
                </h3>
                {logSummary.length === 0 ? (
                  <p className="text-center text-[var(--text-muted)] text-sm py-6">لا توجد أحداث مسجَّلة بعد</p>
                ) : (
                  <div className="space-y-3">
                    {logSummary.map(s => {
                      const ev = EVENT_LABELS[s.event_type] || { label: s.event_type, color: 'text-[var(--text-secondary)]', icon: Activity };
                      return (
                        <div key={s.event_type} className="flex items-center gap-3">
                          <div className="flex items-center gap-2 w-36">
                            <ev.icon className={cn('w-4 h-4 shrink-0', ev.color)} />
                            <span className={cn('text-sm font-medium', ev.color)}>{ev.label}</span>
                          </div>
                          <div className="flex-1 flex items-center gap-4 text-xs">
                            <span className="text-[var(--text-muted)]">
                              <span className="font-bold text-[var(--text-secondary)]">{s.last_hour}</span> / ساعة
                            </span>
                            <span className="text-[var(--text-muted)]">
                              <span className="font-bold text-[var(--text-secondary)]">{s.last_day}</span> / يوم
                            </span>
                            <span className="text-[var(--text-muted)]">
                              <span className="font-bold text-[var(--text-secondary)]">{s.last_week}</span> / أسبوع
                            </span>
                          </div>
                          <span className="text-xs text-[var(--text-muted)]">
                            {s.last_at ? new Date(s.last_at).toLocaleString('ar-SA') : '—'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* حالة الحسابات مختصرة */}
            <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
              <CardContent className="p-5">
                <h3 className="font-bold text-sm mb-4 flex items-center gap-2">
                  <Users className="w-4 h-4 text-[var(--brand-primary)]" />
                  حالة الحسابات
                </h3>
                {accounts.length === 0 ? (
                  <p className="text-center text-[var(--text-muted)] text-sm py-4">لا توجد حسابات</p>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {accounts.map(acc => (
                      <div key={acc.id} className={cn(
                        'flex items-center gap-3 p-3 rounded-xl border transition-all',
                        acc.is_suspended
                          ? 'bg-orange-500/5 border-orange-500/20'
                          : acc.status === 'connected'
                            ? 'bg-emerald-500/5 border-emerald-500/20'
                            : 'bg-[var(--bg-elevated)] border-[var(--border-default)]'
                      )}>
                        <div className={cn(
                          'w-8 h-8 rounded-xl flex items-center justify-center shrink-0',
                          acc.is_suspended ? 'bg-orange-500/15' : acc.status === 'connected' ? 'bg-emerald-500/15' : 'bg-[var(--bg-overlay)]'
                        )}>
                          {acc.is_suspended
                            ? <Ban className="w-4 h-4 text-orange-400" />
                            : acc.status === 'connected'
                              ? <Wifi className="w-4 h-4 text-emerald-400" />
                              : <ShieldOff className="w-4 h-4 text-[var(--text-muted)]" />}
                        </div>
                        <div className="overflow-hidden">
                          <p className="text-xs font-semibold truncate">{acc.name || acc.phone_number || acc.id.slice(0, 8)}</p>
                          <p className={cn('text-xs', acc.is_suspended ? 'text-orange-400' : acc.status === 'connected' ? 'text-emerald-400' : 'text-[var(--text-muted)]')}>
                            {acc.is_suspended ? 'موقوف' : acc.status === 'connected' ? 'متصل' : 'منفصل'}
                          </p>
                          {acc.recent_errors > 0 && (
                            <p className="text-xs text-red-400">{acc.recent_errors} خطأ / ساعة</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* ════════════════════════════════════════════════
            تبويب 2: الإعدادات
        ════════════════════════════════════════════════ */}
        {activeTab === 'config' && draftConfig && (
          <>
            {/* تفعيل / تعطيل نظام الحماية */}
            <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'w-10 h-10 rounded-2xl flex items-center justify-center',
                      draftConfig.is_active ? 'bg-emerald-500/15' : 'bg-red-500/10'
                    )}>
                      <Shield className={cn('w-5 h-5', draftConfig.is_active ? 'text-emerald-400' : 'text-red-400')} />
                    </div>
                    <div>
                      <p className="font-bold">تفعيل نظام الحماية</p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {draftConfig.is_active ? 'النظام يعمل ويراقب جميع العمليات' : 'النظام معطَّل — لا حماية نشطة'}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setDraftConfig(p => p ? ({ ...p, is_active: !p.is_active }) : p)}
                    className={cn(
                      'relative w-14 h-7 rounded-full transition-all duration-300',
                      draftConfig.is_active ? 'bg-emerald-500' : 'bg-[var(--border-strong)]'
                    )}
                  >
                    <span className={cn(
                      'absolute top-1 w-5 h-5 rounded-full bg-white shadow-md transition-all duration-300',
                      draftConfig.is_active ? 'right-1' : 'left-1'
                    )} />
                  </button>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

              {/* حدود السرعة */}
              <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                <CardContent className="p-5 space-y-5">
                  <h3 className="font-bold text-sm flex items-center gap-2">
                    <Gauge className="w-4 h-4 text-blue-400" />
                    تحديد سرعة العمليات
                  </h3>
                  <SliderInput
                    label="الحد الساعي"
                    value={draftConfig.max_ops_per_hour}
                    min={1} max={100}
                    unit=" عملية/ساعة"
                    description="آمن: 10–30"
                    onChange={v => setDraftConfig(p => p ? ({ ...p, max_ops_per_hour: v }) : p)}
                  />
                  <SliderInput
                    label="الحد اليومي"
                    value={draftConfig.max_ops_per_day}
                    min={10} max={500}
                    unit=" عملية/يوم"
                    description="آمن: 50–150"
                    onChange={v => setDraftConfig(p => p ? ({ ...p, max_ops_per_day: v }) : p)}
                  />
                  <SliderInput
                    label="الحد الأدنى للتأخير"
                    value={draftConfig.min_delay_between_ops}
                    min={5} max={300}
                    unit="ث"
                    description="بين العمليات"
                    onChange={v => setDraftConfig(p => p ? ({ ...p, min_delay_between_ops: v }) : p)}
                  />
                  <SliderInput
                    label="الحد الأقصى للتأخير"
                    value={draftConfig.max_delay_between_ops}
                    min={30} max={600}
                    unit="ث"
                    description="عشوائي آمن"
                    onChange={v => setDraftConfig(p => p ? ({ ...p, max_delay_between_ops: v }) : p)}
                  />
                </CardContent>
              </Card>

              {/* توزيع المهام */}
              <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                <CardContent className="p-5 space-y-4">
                  <h3 className="font-bold text-sm flex items-center gap-2">
                    <Users className="w-4 h-4 text-purple-400" />
                    توزيع المهام على الحسابات
                  </h3>
                  {DIST_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setDraftConfig(p => p ? ({ ...p, distribution_mode: opt.value as any }) : p)}
                      className={cn(
                        'w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-right',
                        draftConfig.distribution_mode === opt.value
                          ? 'bg-[var(--brand-primary)]/10 border-[var(--brand-primary)]/40 text-[var(--brand-primary)]'
                          : 'bg-[var(--bg-elevated)] border-[var(--border-default)] hover:border-[var(--border-strong)]'
                      )}
                    >
                      <div className={cn(
                        'w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center',
                        draftConfig.distribution_mode === opt.value ? 'border-[var(--brand-primary)]' : 'border-[var(--border-strong)]'
                      )}>
                        {draftConfig.distribution_mode === opt.value && (
                          <div className="w-2 h-2 rounded-full bg-[var(--brand-primary)]" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium">{opt.label}</p>
                        <p className="text-xs text-[var(--text-muted)]">{opt.desc}</p>
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>

              {/* مراقبة الأخطاء والإيقاف التلقائي */}
              <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                <CardContent className="p-5 space-y-4">
                  <h3 className="font-bold text-sm flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-orange-400" />
                    مراقبة الأخطاء والإيقاف التلقائي
                  </h3>
                  <SliderInput
                    label="حد الأخطاء المتتالية"
                    value={draftConfig.error_threshold}
                    min={1} max={20}
                    unit=" خطأ"
                    description="قبل إيقاف الحساب"
                    onChange={v => setDraftConfig(p => p ? ({ ...p, error_threshold: v }) : p)}
                  />
                  <Toggle
                    checked={draftConfig.auto_disable_on_error}
                    onChange={v => setDraftConfig(p => p ? ({ ...p, auto_disable_on_error: v }) : p)}
                    label="الإيقاف التلقائي عند الأخطاء"
                    desc="يوقف الحساب فور تجاوز الحد المحدد"
                  />
                </CardContent>
              </Card>

              {/* إعادة المحاولة الذكية */}
              <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                <CardContent className="p-5 space-y-4">
                  <h3 className="font-bold text-sm flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-cyan-400" />
                    إعادة المحاولة الذكية
                  </h3>
                  <Toggle
                    checked={draftConfig.retry_enabled}
                    onChange={v => setDraftConfig(p => p ? ({ ...p, retry_enabled: v }) : p)}
                    label="تفعيل إعادة المحاولة"
                    desc="Exponential Backoff تلقائي"
                  />
                  {draftConfig.retry_enabled && (
                    <>
                      <SliderInput
                        label="الحد الأقصى للمحاولات"
                        value={draftConfig.max_retries}
                        min={1} max={10}
                        unit=" مرات"
                        description=""
                        onChange={v => setDraftConfig(p => p ? ({ ...p, max_retries: v }) : p)}
                      />
                      <SliderInput
                        label="التأخير الأساسي"
                        value={draftConfig.retry_base_delay}
                        min={10} max={300}
                        unit="ث"
                        description="يتضاعف مع كل محاولة"
                        onChange={v => setDraftConfig(p => p ? ({ ...p, retry_base_delay: v }) : p)}
                      />
                      <SliderInput
                        label="الحد الأقصى للتأخير"
                        value={draftConfig.retry_max_delay}
                        min={60} max={3600}
                        step={60}
                        unit="ث"
                        description="سقف exponential"
                        onChange={v => setDraftConfig(p => p ? ({ ...p, retry_max_delay: v }) : p)}
                      />
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* حفظ الإعدادات */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={resetConfig}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors text-sm"
              >
                <RotateCcw className="w-4 h-4" />
                إعادة الضبط
              </button>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setDraftConfig(config)}
                  className="px-4 py-2.5 rounded-xl border border-[var(--border-default)] text-sm hover:bg-[var(--bg-elevated)] transition-colors"
                >
                  إلغاء التغييرات
                </button>
                <button
                  onClick={saveConfig}
                  disabled={saving}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-[var(--brand-primary)] text-white font-bold hover:brightness-110 transition-all disabled:opacity-60 text-sm"
                >
                  {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  {saving ? 'جاري الحفظ…' : 'حفظ الإعدادات'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* ════════════════════════════════════════════════
            تبويب 3: الحسابات
        ════════════════════════════════════════════════ */}
        {activeTab === 'accounts' && (
          <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-bold text-sm flex items-center gap-2">
                  <Users className="w-4 h-4 text-[var(--brand-primary)]" />
                  إدارة حالة الحسابات
                </h3>
                <Badge className="bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border-default)] text-xs">
                  {accounts.length} حساب
                </Badge>
              </div>

              {accounts.length === 0 ? (
                <p className="text-center text-[var(--text-muted)] text-sm py-10">لا توجد حسابات مضافة</p>
              ) : (
                <div className="space-y-3">
                  {accounts.map(acc => (
                    <div key={acc.id} className={cn(
                      'flex items-center gap-4 p-4 rounded-xl border transition-all',
                      acc.is_suspended
                        ? 'bg-orange-500/5 border-orange-500/20'
                        : acc.status === 'connected'
                          ? 'bg-emerald-500/5 border-emerald-500/20'
                          : 'bg-[var(--bg-elevated)] border-[var(--border-default)]'
                    )}>
                      {/* أيقونة الحالة */}
                      <div className={cn(
                        'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                        acc.is_suspended ? 'bg-orange-500/15' : acc.status === 'connected' ? 'bg-emerald-500/15' : 'bg-[var(--bg-overlay)]'
                      )}>
                        {acc.is_suspended
                          ? <Ban className="w-5 h-5 text-orange-400" />
                          : acc.status === 'connected'
                            ? <ShieldCheck className="w-5 h-5 text-emerald-400" />
                            : <ShieldOff className="w-5 h-5 text-[var(--text-muted)]" />
                        }
                      </div>

                      {/* معلومات الحساب */}
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {acc.name || acc.phone_number || `حساب ${acc.id.slice(0, 8)}`}
                        </p>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className={cn('text-xs', acc.is_suspended ? 'text-orange-400' : acc.status === 'connected' ? 'text-emerald-400' : 'text-[var(--text-muted)]')}>
                            {acc.is_suspended ? '⚠ موقوف تلقائياً' : acc.status === 'connected' ? '● متصل' : '○ منفصل'}
                          </span>
                          {acc.suspended_at && acc.is_suspended && (
                            <span className="text-xs text-[var(--text-muted)]">
                              منذ {new Date(acc.suspended_at).toLocaleString('ar-SA')}
                            </span>
                          )}
                          {acc.recent_errors > 0 && (
                            <span className="text-xs text-red-400 flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              {acc.recent_errors} خطأ/ساعة
                            </span>
                          )}
                        </div>
                      </div>

                      {/* زر التبديل */}
                      <button
                        onClick={() => toggleAccountSuspension(acc)}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                          acc.is_suspended
                            ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30'
                            : 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 border border-orange-500/20'
                        )}
                      >
                        {acc.is_suspended
                          ? <><Play className="w-3 h-3" /> استئناف</>
                          : <><Square className="w-3 h-3" /> إيقاف مؤقت</>
                        }
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ════════════════════════════════════════════════
            تبويب 4: السجل الأمني
        ════════════════════════════════════════════════ */}
        {activeTab === 'logs' && (
          <>
            {/* فلاتر السجل */}
            <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
              <CardContent className="p-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-[var(--text-muted)]" />
                    <span className="text-sm text-[var(--text-muted)]">فلتر:</span>
                  </div>
                  <button
                    onClick={() => setLogEventFilter('')}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                      logEventFilter === ''
                        ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)] border-[var(--brand-primary)]/30'
                        : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[var(--border-strong)]'
                    )}
                  >
                    الكل
                  </button>
                  {Object.entries(EVENT_LABELS).map(([key, ev]) => (
                    <button
                      key={key}
                      onClick={() => setLogEventFilter(key)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                        logEventFilter === key
                          ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)] border-[var(--brand-primary)]/30'
                          : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[var(--border-strong)]'
                      )}
                    >
                      <ev.icon className={cn('w-3 h-3', ev.color)} />
                      {ev.label}
                    </button>
                  ))}
                  <div className="mr-auto flex items-center gap-2">
                    <span className="text-xs text-[var(--text-muted)]">{logTotal} سجل</span>
                    <button
                      onClick={clearOldLogs}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all"
                    >
                      <Trash2 className="w-3 h-3" />
                      حذف القديمة
                    </button>
                    <button
                      onClick={() => fetchLogs(logPage, logEventFilter)}
                      className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* جدول السجلات */}
            <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
              <CardContent className="p-0">
                {logs.length === 0 ? (
                  <div className="text-center py-12 text-[var(--text-muted)]">
                    <List className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">لا توجد سجلات أمنية</p>
                    <p className="text-xs mt-1 opacity-60">ستظهر الأحداث هنا فور تشغيل نظام الحماية</p>
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--border-default)]">
                    {logs.map(log => {
                      const ev = EVENT_LABELS[log.event_type] || { label: log.event_type, color: 'text-[var(--text-secondary)]', icon: Activity };
                      return (
                        <div key={log.id} className="flex items-start gap-4 px-5 py-3.5 hover:bg-[var(--bg-elevated)]/40 transition-colors">
                          <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
                            log.event_type === 'join_success' ? 'bg-emerald-500/10' :
                            log.event_type === 'join_failed'  ? 'bg-red-500/10' :
                            log.event_type === 'auto_disable' ? 'bg-orange-500/10' :
                            log.event_type === 'rate_limit'   ? 'bg-yellow-500/10' :
                            log.event_type === 'retry'        ? 'bg-purple-500/10' :
                            'bg-[var(--bg-elevated)]'
                          )}>
                            <ev.icon className={cn('w-3.5 h-3.5', ev.color)} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className={cn('text-xs font-semibold', ev.color)}>{ev.label}</span>
                              {log.account_id && (
                                <span className="text-xs text-[var(--text-muted)] bg-[var(--bg-elevated)] px-1.5 py-0.5 rounded">
                                  {log.account_id.slice(0, 8)}…
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-[var(--text-secondary)] truncate">{log.message}</p>
                            {log.metadata && Object.keys(log.metadata).length > 0 && (
                              <p className="text-xs text-[var(--text-muted)] mt-0.5 font-mono">
                                {JSON.stringify(log.metadata).slice(0, 80)}
                              </p>
                            )}
                          </div>
                          <span className="text-xs text-[var(--text-muted)] shrink-0 mt-1">
                            {new Date(log.created_at).toLocaleString('ar-SA', { hour12: false })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* ترقيم الصفحات */}
                {logTotal > logsPerPage && (
                  <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--border-default)]">
                    <button
                      disabled={logPage === 0}
                      onClick={() => fetchLogs(logPage - 1, logEventFilter)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border-default)] hover:bg-[var(--bg-elevated)] disabled:opacity-40 transition-all"
                    >
                      <ArrowRight className="w-3 h-3 rotate-180" />
                      السابق
                    </button>
                    <span className="text-xs text-[var(--text-muted)]">
                      صفحة {logPage + 1} / {Math.ceil(logTotal / logsPerPage)}
                    </span>
                    <button
                      disabled={(logPage + 1) * logsPerPage >= logTotal}
                      onClick={() => fetchLogs(logPage + 1, logEventFilter)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border-default)] hover:bg-[var(--bg-elevated)] disabled:opacity-40 transition-all"
                    >
                      التالي
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

      </div>
    </div>
  );
}
