import React, { useState, useEffect, useCallback } from 'react';
import {
  Users, Plus, Search, RefreshCw, Edit2, Trash2,
  Clock, CheckCircle, XCircle, AlertTriangle,
  ChevronLeft, ChevronRight, X, Eye, EyeOff,
  Calendar, Shield, Hash, ToggleLeft, ToggleRight,
  Send
} from 'lucide-react';
import { authFetch, API } from '../utils/api';
import { useToast } from '../components/ui/ToastProvider';

// ── الثوابت ──────────────────────────────────────────────────────────────────
const DURATIONS = [
  { value: 'day',     label: 'يوم واحد' },
  { value: 'month',   label: 'شهر واحد' },
  { value: '2months', label: 'شهران' },
  { value: '3months', label: '3 أشهر' },
  { value: 'year',    label: 'سنة كاملة' },
];

const ACCOUNT_LIMITS = [
  { value: 1,  label: 'حساب واحد' },
  { value: 2,  label: 'حسابان' },
  { value: 3,  label: '3 حسابات' },
  { value: 4,  label: '4 حسابات' },
  { value: 5,  label: '5 حسابات' },
  { value: 6,  label: '6 حسابات' },
  { value: 7,  label: '7 حسابات' },
  { value: -1, label: 'غير محدود' },
];

// ── مساعدات ───────────────────────────────────────────────────────────────────
function StatusBadge({ status, isExpired }: { status: string; isExpired?: boolean }) {
  if (isExpired) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/25">
      <AlertTriangle className="w-3 h-3" /> منتهي
    </span>
  );
  if (status === 'active') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
      <CheckCircle className="w-3 h-3" /> فعّال
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-500/15 text-zinc-400 border border-zinc-500/25">
      <XCircle className="w-3 h-3" /> {status === 'suspended' ? 'موقوف' : 'ملغي'}
    </span>
  );
}

// ── مكوّن Toggle تيلجرام ──────────────────────────────────────────────────────
function TelegramToggle({
  enabled,
  onChange,
  showLabel = false,
}: {
  enabled: boolean;
  onChange: (val: boolean) => void;
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`
        relative inline-flex items-center gap-2 transition-all
        ${showLabel ? 'w-full justify-between px-3 py-2.5 rounded-xl border' : ''}
        ${showLabel && enabled
          ? 'bg-blue-500/10 border-blue-500/30'
          : showLabel
          ? 'bg-[var(--bg-elevated)] border-[var(--border-default)] hover:border-blue-500/30'
          : ''}
      `}
    >
      {showLabel && (
        <span className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Send className="w-4 h-4 text-blue-400" />
          تفعيل زر التيلجرام للمشترك
        </span>
      )}
      {/* مفتاح Toggle */}
      <span
        className={`
          relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200
          ${enabled ? 'bg-blue-500' : 'bg-zinc-600'}
        `}
      >
        <span
          className={`
            inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200
            ${enabled ? 'translate-x-4' : 'translate-x-0.5'}
          `}
        />
      </span>
    </button>
  );
}

// ── Modal إنشاء / تعديل ───────────────────────────────────────────────────────
interface ModalProps {
  mode: 'create' | 'edit' | 'extend' | 'view';
  subscriber?: any;
  onClose: () => void;
  onSuccess: () => void;
}

function SubscriberModal({ mode, subscriber, onClose, onSuccess }: ModalProps) {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);

  const [form, setForm] = useState({
    username:        subscriber?.username       || '',
    password:        '',
    fullName:        subscriber?.full_name      || '',
    duration:        subscriber?.duration       || 'month',
    maxAccounts:     subscriber?.max_accounts   ?? 1,
    enableTelegram:  subscriber?.enable_telegram ?? false,
    note:            '',
  });

  const isCreate = mode === 'create';
  const isExtend = mode === 'extend';
  const isView   = mode === 'view';
  const isEdit   = mode === 'edit';

  async function handleSubmit() {
    setLoading(true);
    try {
      let url = `${API}/admin/subscriptions`;
      let method = 'POST';
      let body: any = {};

      if (isCreate) {
        body = {
          username: form.username,
          password: form.password,
          fullName: form.fullName,
          duration: form.duration,
          maxAccounts: Number(form.maxAccounts),
          enableTelegram: form.enableTelegram,
        };
      } else if (isEdit) {
        url    = `${API}/admin/subscriptions/${subscriber.user_id}`;
        method = 'PATCH';
        body   = {
          fullName: form.fullName,
          maxAccounts: Number(form.maxAccounts),
          enableTelegram: form.enableTelegram,
        };
        if (form.password) body.password = form.password;
        if (form.duration) body.duration = form.duration;
      } else if (isExtend) {
        url    = `${API}/admin/subscriptions/${subscriber.user_id}/extend`;
        method = 'POST';
        body   = { duration: form.duration, note: form.note };
      }

      const res = await authFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();

      if (data.success) {
        addToast({ title: 'تم بنجاح', description: data.message || 'تمت العملية.', type: 'success' });
        onSuccess();
        onClose();
      } else {
        addToast({ title: 'خطأ', description: data.error || 'فشلت العملية.', type: 'error' });
      }
    } catch {
      addToast({ title: 'خطأ', description: 'تعذر الاتصال بالخادم.', type: 'error' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" dir="rtl">
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-default)]">
          <h2 className="text-base font-bold text-[var(--text-primary)]">
            {isCreate ? 'إنشاء مشترك جديد' : isEdit ? 'تعديل المشترك' : isExtend ? 'تمديد الاشتراك' : 'تفاصيل المشترك'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors">
            <X className="w-4 h-4 text-[var(--text-muted)]" />
          </button>
        </div>

        {/* Body */}
        {isView ? (
          <div className="p-5 space-y-4">
            <InfoRow label="اسم المستخدم" value={subscriber.username} />
            <InfoRow label="الاسم الكامل" value={subscriber.full_name || '—'} />
            <InfoRow label="مدة الاشتراك" value={DURATIONS.find(d => d.value === subscriber.duration)?.label || subscriber.duration} />
            <InfoRow label="تاريخ الانتهاء" value={subscriber.expires_at ? new Date(subscriber.expires_at).toLocaleDateString('ar-SA') : '—'} />
            <InfoRow label="الأيام المتبقية" value={subscriber.daysRemaining !== null ? `${subscriber.daysRemaining} يوم` : '—'} />
            <InfoRow label="الحسابات" value={`${subscriber.usedAccounts} / ${subscriber.maxAccounts === null ? '∞' : subscriber.maxAccounts}`} />
            <InfoRow label="زر التيلجرام" value={subscriber.enable_telegram ? '✅ مفعّل' : '❌ معطّل'} />
            <InfoRow label="آخر دخول" value={subscriber.last_login ? new Date(subscriber.last_login).toLocaleString('ar-SA') : 'لم يسجّل دخولاً بعد'} />
          </div>
        ) : (
          <div className="p-5 space-y-4">
            {isCreate && (
              <>
                <Field label="اسم المستخدم *">
                  <input className="input" value={form.username} onChange={e => setForm(f => ({...f, username: e.target.value}))} placeholder="user123" dir="ltr" />
                </Field>
                <Field label="الاسم الكامل">
                  <input className="input" value={form.fullName} onChange={e => setForm(f => ({...f, fullName: e.target.value}))} placeholder="اسم المشترك" />
                </Field>
              </>
            )}
            {isEdit && (
              <Field label="الاسم الكامل">
                <input className="input" value={form.fullName} onChange={e => setForm(f => ({...f, fullName: e.target.value}))} />
              </Field>
            )}
            {(isCreate || isEdit) && (
              <Field label={isCreate ? 'كلمة المرور *' : 'كلمة مرور جديدة (اتركها فارغة إن لم تريد تغييرها)'}>
                <div className="relative">
                  <input
                    className="input pl-10" type={showPass ? 'text' : 'password'}
                    value={form.password} onChange={e => setForm(f => ({...f, password: e.target.value}))}
                    placeholder="••••••••" dir="ltr"
                  />
                  <button type="button" onClick={() => setShowPass(s => !s)} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </Field>
            )}
            {!isEdit && !isExtend && (
              <Field label="مدة الاشتراك *">
                <select className="input" value={form.duration} onChange={e => setForm(f => ({...f, duration: e.target.value}))}>
                  {DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </Field>
            )}
            {isEdit && (
              <Field label="مدة الاشتراك (تغيير الانتهاء)">
                <select className="input" value={form.duration} onChange={e => setForm(f => ({...f, duration: e.target.value}))}>
                  {DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </Field>
            )}
            {(isCreate || isEdit) && (
              <Field label="الحد الأقصى للحسابات *">
                <select
                  className="input"
                  value={form.maxAccounts}
                  onChange={e => setForm(f => ({...f, maxAccounts: Number(e.target.value)}))}
                >
                  {ACCOUNT_LIMITS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </Field>
            )}

            {/* ── خيار تيلجرام (إنشاء / تعديل فقط) ── */}
            {(isCreate || isEdit) && (
              <Field label="ميزات إضافية">
                <TelegramToggle
                  enabled={form.enableTelegram}
                  onChange={val => setForm(f => ({...f, enableTelegram: val}))}
                  showLabel
                />
                {form.enableTelegram && (
                  <p className="text-xs text-blue-400 mt-1 flex items-center gap-1">
                    <Send className="w-3 h-3" />
                    سيظهر زر «التيلجرام التفاعلي» في لوحة هذا المشترك
                  </p>
                )}
              </Field>
            )}

            {isExtend && (
              <>
                <div className="p-3 rounded-xl bg-[var(--bg-elevated)] text-sm text-[var(--text-secondary)]">
                  المشترك: <strong className="text-[var(--text-primary)]">{subscriber.username}</strong>
                  {subscriber.expires_at && (
                    <> · ينتهي: <strong className="text-[var(--text-primary)]">{new Date(subscriber.expires_at).toLocaleDateString('ar-SA')}</strong></>
                  )}
                </div>
                <Field label="مدة التمديد *">
                  <select className="input" value={form.duration} onChange={e => setForm(f => ({...f, duration: e.target.value}))}>
                    {DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </Field>
                <Field label="ملاحظة">
                  <input className="input" value={form.note} onChange={e => setForm(f => ({...f, note: e.target.value}))} placeholder="اختياري..." />
                </Field>
              </>
            )}
          </div>
        )}

        {/* Footer */}
        {!isView && (
          <div className="flex items-center gap-3 p-5 border-t border-[var(--border-default)]">
            <button onClick={handleSubmit} disabled={loading}
              className="flex-1 h-10 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-[var(--brand-primary)] to-[#008f6e] hover:brightness-110 transition-all disabled:opacity-60 flex items-center justify-center gap-2">
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
              {isCreate ? 'إنشاء المشترك' : isEdit ? 'حفظ التعديلات' : 'تمديد الاشتراك'}
            </button>
            <button onClick={onClose} className="px-4 h-10 rounded-xl text-sm text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] transition-colors">إلغاء</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-[var(--text-secondary)]">{label}</label>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--border-default)] last:border-0">
      <span className="text-xs text-[var(--text-muted)]">{label}</span>
      <span className="text-sm font-medium text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main View
// ══════════════════════════════════════════════════════════════════════════════
export default function SubscriptionsView() {
  const { addToast } = useToast();
  const [subscribers, setSubscribers] = useState<any[]>([]);
  const [loading, setLoading]         = useState(false);
  const [search, setSearch]           = useState('');
  const [page, setPage]               = useState(1);
  const [total, setTotal]             = useState(0);
  const LIMIT = 20;

  const [modal, setModal] = useState<{ mode: ModalProps['mode']; subscriber?: any } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      if (search) params.set('search', search);
      const res  = await authFetch(`${API}/admin/subscriptions?${params}`);
      const data = await res.json();
      if (data.success) {
        setSubscribers(data.subscribers);
        setTotal(data.total);
      }
    } catch {
      addToast({ title: 'خطأ', description: 'تعذر جلب المشتركين.', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => { load(); }, [load]);

  async function toggleStatus(sub: any) {
    const newStatus = sub.sub_status === 'active' && !sub.isExpired ? 'suspended' : 'active';
    try {
      const res = await authFetch(`${API}/admin/subscriptions/${sub.user_id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (data.success) {
        addToast({ title: 'تم', description: data.message, type: 'success' });
        load();
      } else {
        addToast({ title: 'خطأ', description: data.error, type: 'error' });
      }
    } catch {
      addToast({ title: 'خطأ', description: 'تعذر تغيير الحالة.', type: 'error' });
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res  = await authFetch(`${API}/admin/subscriptions/${deleteTarget.user_id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        addToast({ title: 'تم الحذف', description: data.message, type: 'success' });
        setDeleteTarget(null);
        load();
      } else {
        addToast({ title: 'خطأ', description: data.error, type: 'error' });
      }
    } catch {
      addToast({ title: 'خطأ', description: 'تعذر الحذف.', type: 'error' });
    } finally {
      setDeleteLoading(false);
    }
  }

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="p-6 space-y-5" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Shield className="w-5 h-5 text-[var(--brand-primary)]" />
            إدارة الاشتراكات
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">{total} مشترك مسجّل</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 rounded-xl border border-[var(--border-default)] hover:bg-[var(--bg-elevated)] transition-colors">
            <RefreshCw className={`w-4 h-4 text-[var(--text-muted)] ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setModal({ mode: 'create' })}
            className="h-9 px-4 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-[var(--brand-primary)] to-[#008f6e] hover:brightness-110 transition-all flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> مشترك جديد
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
        <input
          className="input pr-9 max-w-sm"
          placeholder="بحث باسم المستخدم..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      {/* Table */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">جاري التحميل...</div>
        ) : subscribers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <Users className="w-8 h-8 text-[var(--text-muted)] opacity-40" />
            <p className="text-sm text-[var(--text-muted)]">لا يوجد مشتركين</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] text-xs text-[var(--text-muted)]">
                  <th className="text-right py-3 px-4 font-medium">المشترك</th>
                  <th className="text-right py-3 px-4 font-medium">الاشتراك</th>
                  <th className="text-right py-3 px-4 font-medium">الحسابات</th>
                  <th className="text-right py-3 px-4 font-medium">الانتهاء</th>
                  <th className="text-right py-3 px-4 font-medium">تيلجرام</th>
                  <th className="text-right py-3 px-4 font-medium">الحالة</th>
                  <th className="text-right py-3 px-4 font-medium">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {subscribers.map((sub, i) => (
                  <tr key={sub.user_id} className={`border-b border-[var(--border-default)] last:border-0 hover:bg-[var(--bg-elevated)]/50 transition-colors ${i % 2 === 0 ? '' : 'bg-[var(--bg-elevated)]/20'}`}>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-[var(--text-primary)]">{sub.username}</div>
                      <div className="text-xs text-[var(--text-muted)]">{sub.full_name}</div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-[var(--text-secondary)]">
                        {DURATIONS.find(d => d.value === sub.duration)?.label || sub.duration || '—'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1.5">
                        <Hash className="w-3 h-3 text-[var(--text-muted)]" />
                        <span className="font-mono text-[var(--text-primary)]">
                          {sub.usedAccounts} / {sub.maxAccounts === null ? '∞' : sub.maxAccounts}
                        </span>
                        {sub.remainingAccounts !== null && sub.remainingAccounts === 0 && (
                          <span className="text-xs text-amber-400">(الحد الأقصى)</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="w-3 h-3 text-[var(--text-muted)]" />
                        <span className={`text-xs ${sub.isExpired ? 'text-red-400' : sub.daysRemaining <= 3 ? 'text-amber-400' : 'text-[var(--text-secondary)]'}`}>
                          {sub.expires_at ? new Date(sub.expires_at).toLocaleDateString('ar-SA') : '—'}
                        </span>
                      </div>
                      {sub.daysRemaining !== null && !sub.isExpired && (
                        <div className="text-xs text-[var(--text-muted)] mt-0.5">
                          {sub.daysRemaining === 0 ? 'اليوم الأخير' : `${sub.daysRemaining} يوم`}
                        </div>
                      )}
                    </td>
                    {/* عمود تيلجرام */}
                    <td className="py-3 px-4">
                      {sub.enable_telegram ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400 border border-blue-500/25">
                          <Send className="w-3 h-3" /> مفعّل
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-500/10 text-zinc-500 border border-zinc-500/20">
                          معطّل
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={sub.sub_status || 'inactive'} isExpired={sub.isExpired} />
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1">
                        <button onClick={() => setModal({ mode: 'view', subscriber: sub })} title="عرض" className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setModal({ mode: 'edit', subscriber: sub })} title="تعديل" className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors text-[var(--text-muted)] hover:text-[var(--brand-primary)]">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setModal({ mode: 'extend', subscriber: sub })} title="تمديد" className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors text-[var(--text-muted)] hover:text-emerald-400">
                          <Clock className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => toggleStatus(sub)} title={sub.sub_status === 'active' && !sub.isExpired ? 'إيقاف' : 'تفعيل'} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors text-[var(--text-muted)]">
                          {sub.sub_status === 'active' && !sub.isExpired
                            ? <ToggleRight className="w-3.5 h-3.5 text-emerald-400" />
                            : <ToggleLeft className="w-3.5 h-3.5 text-zinc-500" />
                          }
                        </button>
                        <button onClick={() => setDeleteTarget(sub)} title="حذف" className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors text-[var(--text-muted)] hover:text-red-400">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="p-2 rounded-lg border border-[var(--border-default)] disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="text-sm text-[var(--text-muted)]">{page} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-2 rounded-lg border border-[var(--border-default)] disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Modals */}
      {modal && (
        <SubscriberModal
          mode={modal.mode}
          subscriber={modal.subscriber}
          onClose={() => setModal(null)}
          onSuccess={load}
        />
      )}

      {/* Delete Confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" dir="rtl">
          <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="font-bold text-[var(--text-primary)]">تأكيد الحذف</h3>
                <p className="text-xs text-[var(--text-muted)]">هذا الإجراء لا يمكن التراجع عنه</p>
              </div>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              سيتم حذف المشترك <strong className="text-[var(--text-primary)]">{deleteTarget.username}</strong> وجميع بياناته وحساباته بشكل نهائي.
            </p>
            <div className="flex gap-2">
              <button
                onClick={confirmDelete}
                disabled={deleteLoading}
                className="flex-1 h-9 rounded-xl bg-red-500/90 hover:bg-red-500 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {deleteLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
                حذف نهائياً
              </button>
              <button onClick={() => setDeleteTarget(null)} className="flex-1 h-9 rounded-xl border border-[var(--border-default)] text-sm text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] transition-colors">
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
