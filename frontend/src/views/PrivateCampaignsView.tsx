import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Rocket, Plus, Play, Pause, Trash2, Eye, RefreshCcw,
  Users, Clock, CalendarRange, MessageSquare, Zap, Check,
  ChevronRight, BarChart2, AlertCircle, Target, Settings2,
  Smartphone, Timer, ArrowRight, Radio, X, Info, TrendingUp
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { authFetch, API } from '@/utils/api';

// ─── Types ────────────────────────────────────────────────────────────────────
interface PrivateCampaign {
  id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed';
  message_text: string;
  target_groups_count: number;
  accounts_count: number;
  messages_per_account: number;
  interval_seconds: number;
  start_time: string;
  end_time: string;
  sent_count: number;
  failed_count: number;
  total_targets: number;
  created_at: string;
  updated_at: string;
}

interface Group {
  id: string;
  group_jid: string;
  name: string;
  participants_count: number;
  is_active: boolean;
}

interface Account {
  id: string;
  name: string;
  phone: string;
  status: 'connected' | 'disconnected' | 'banned';
}

interface CampaignLog {
  id: string;
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
  account_id?: string;
  created_at: string;
}

// ─── Wizard Step Config ───────────────────────────────────────────────────────
const WIZARD_STEPS = [
  { id: 1, label: 'الاسم والمحتوى',  icon: MessageSquare },
  { id: 2, label: 'المجموعات',       icon: Target        },
  { id: 3, label: 'الحسابات',        icon: Smartphone    },
  { id: 4, label: 'التوقيت',         icon: Timer         },
  { id: 5, label: 'المراجعة',        icon: Check         },
];

// ─── Helper: status badge ─────────────────────────────────────────────────────
function StatusBadge({ status }: { status: PrivateCampaign['status'] }) {
  const cfg = {
    draft:     { label: 'مسودة',    cls: 'bg-gray-500/10 text-gray-400'   },
    scheduled: { label: 'مجدولة',   cls: 'bg-blue-500/10 text-blue-400'   },
    running:   { label: 'نشطة',     cls: 'bg-green-500/10 text-green-500'  },
    paused:    { label: 'متوقفة',   cls: 'bg-yellow-500/10 text-yellow-500' },
    completed: { label: 'مكتملة',   cls: 'bg-purple-500/10 text-purple-400' },
    failed:    { label: 'فشلت',     cls: 'bg-red-500/10 text-red-400'     },
  }[status] ?? { label: status, cls: '' };

  return (
    <Badge variant="outline" className={cn('border-0 font-semibold text-xs px-2.5 py-0.5', cfg.cls)}>
      {status === 'running' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5 animate-pulse" />}
      {cfg.label}
    </Badge>
  );
}

// ─── Helper: format date/time ─────────────────────────────────────────────────
function fmtDateTime(iso: string) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('ar-SA', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Campaign Detail Modal ────────────────────────────────────────────────────
function CampaignDetailModal({
  campaign, onClose, onStart, onPause, onDelete, accountId,
}: {
  campaign: PrivateCampaign;
  onClose: () => void;
  onStart: (id: string) => void;
  onPause: (id: string) => void;
  onDelete: (id: string) => void;
  accountId: string;
}) {
  const [logs, setLogs] = useState<CampaignLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await authFetch(`${API}/private-campaigns/${campaign.id}/logs`);
        const d = await res.json();
        if (d.success) setLogs(d.logs);
      } catch { /* silent */ }
      finally { setLoadingLogs(false); }
    };
    fetchLogs();
    const iv = setInterval(fetchLogs, 5000);
    return () => clearInterval(iv);
  }, [campaign.id]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const progress = campaign.total_targets > 0
    ? Math.round(((campaign.sent_count + campaign.failed_count) / campaign.total_targets) * 100)
    : 0;

  const logColor = (level: string) =>
    ({ info: 'text-blue-400', warning: 'text-yellow-400', error: 'text-red-400', success: 'text-green-400' }[level] ?? 'text-gray-400');

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center">
                <Rocket className="w-5 h-5 text-[var(--brand-primary)]" />
              </div>
              {campaign.name}
            </DialogTitle>
            <StatusBadge status={campaign.status} />
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pt-2">
          {/* Progress */}
          <div className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border-default)]">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-[var(--text-secondary)]">التقدم الكلي</span>
              <span className="text-sm font-bold text-[var(--text-primary)]">{progress}%</span>
            </div>
            <Progress value={progress} className="h-2.5 mb-3" />
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: 'إجمالي الأهداف', val: campaign.total_targets, color: 'text-[var(--text-primary)]' },
                { label: 'تم الإرسال',    val: campaign.sent_count,    color: 'text-green-500' },
                { label: 'فشل',           val: campaign.failed_count,  color: 'text-red-500'   },
              ].map((s, i) => (
                <div key={i} className="bg-[var(--bg-surface)] rounded-lg p-2">
                  <p className={cn('text-xl font-bold', s.color)}>{s.val.toLocaleString()}</p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Settings grid */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Target,      label: 'المجموعات المستهدفة', val: campaign.target_groups_count },
              { icon: Smartphone,  label: 'الحسابات المستخدمة',  val: campaign.accounts_count     },
              { icon: MessageSquare, label: 'رسائل/حساب',        val: campaign.messages_per_account },
              { icon: Clock,       label: 'الفاصل الزمني',       val: `${campaign.interval_seconds} ثانية` },
              { icon: CalendarRange, label: 'وقت البداية',       val: fmtDateTime(campaign.start_time) },
              { icon: CalendarRange, label: 'وقت الانتهاء',      val: fmtDateTime(campaign.end_time)   },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-[var(--bg-elevated)] rounded-xl border border-[var(--border-default)]">
                <div className="w-8 h-8 rounded-lg bg-[var(--bg-surface)] flex items-center justify-center shrink-0">
                  <item.icon className="w-4 h-4 text-[var(--brand-primary)]" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-[var(--text-muted)]">{item.label}</p>
                  <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{item.val}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Message preview */}
          {campaign.message_text && (
            <div className="bg-[var(--bg-elevated)] rounded-xl p-4 border border-[var(--border-default)]">
              <p className="text-xs font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wide">محتوى الرسالة</p>
              <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">{campaign.message_text}</p>
            </div>
          )}

          {/* Logs */}
          <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[var(--border-default)] flex items-center gap-2">
              <Radio className="w-3.5 h-3.5 text-[var(--brand-primary)]" />
              <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide">سجل التنفيذ</span>
            </div>
            <div className="h-48 overflow-y-auto p-3 space-y-1.5 font-mono text-xs">
              {loadingLogs && <p className="text-[var(--text-muted)] text-center py-4">جارٍ التحميل...</p>}
              {!loadingLogs && logs.length === 0 && (
                <p className="text-[var(--text-muted)] text-center py-4">لا توجد سجلات حتى الآن</p>
              )}
              {logs.map(log => (
                <div key={log.id} className="flex gap-2">
                  <span className="text-[var(--text-muted)] shrink-0">
                    {new Date(log.created_at).toLocaleTimeString('ar-SA')}
                  </span>
                  <span className={logColor(log.level)}>[{log.level.toUpperCase()}]</span>
                  <span className="text-[var(--text-secondary)]">{log.message}</span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between items-center pt-4 border-t border-[var(--border-default)]">
          <Button
            variant="outline"
            size="sm"
            className="text-red-500 border-red-500/20 hover:bg-red-500/10"
            onClick={() => { onDelete(campaign.id); onClose(); }}
          >
            <Trash2 className="w-4 h-4 ml-1" />
            حذف
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>إغلاق</Button>
            {(campaign.status === 'draft' || campaign.status === 'paused' || campaign.status === 'scheduled') && (
              <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={() => { onStart(campaign.id); onClose(); }}>
                <Play className="w-4 h-4 ml-1" />
                تشغيل
              </Button>
            )}
            {campaign.status === 'running' && (
              <Button size="sm" className="bg-yellow-600 hover:bg-yellow-700 text-white" onClick={() => { onPause(campaign.id); onClose(); }}>
                <Pause className="w-4 h-4 ml-1" />
                إيقاف مؤقت
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create Wizard ────────────────────────────────────────────────────────────
function CreateCampaignWizard({
  onClose, onCreated, accountId, accounts,
}: {
  onClose: () => void;
  onCreated: () => void;
  accountId: string;
  accounts: Account[];
}) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [searchGroup, setSearchGroup] = useState('');
  const [error, setError] = useState('');

  // Form state
  const [form, setForm] = useState({
    name: '',
    messageText: '',
    selectedGroupIds: [] as string[],
    selectedAccountIds: [] as string[],
    messagesPerAccount: 50,
    intervalSeconds: 15,
    startTime: '',
    endTime: '',
    scheduleMode: 'now' as 'now' | 'later',
  });

  useEffect(() => {
    const fetchGroups = async () => {
      try {
        const res = await authFetch(`${API}/accounts/${accountId}/groups?limit=200`);
        const d = await res.json();
        if (d.success) setGroups(d.groups ?? []);
      } catch { /* silent */ }
      finally { setLoadingGroups(false); }
    };
    fetchGroups();

    // Auto-set start time to now
    const now = new Date();
    now.setMinutes(now.getMinutes() + 5);
    const endT = new Date(now);
    endT.setHours(endT.getHours() + 2);
    setForm(f => ({
      ...f,
      startTime: now.toISOString().slice(0, 16),
      endTime: endT.toISOString().slice(0, 16),
    }));
  }, [accountId]);

  const connectedAccounts = accounts.filter(a => a.status === 'connected');
  const filteredGroups = groups.filter(g =>
    g.name?.toLowerCase().includes(searchGroup.toLowerCase()) || g.group_jid?.includes(searchGroup)
  );

  const toggleGroup = (id: string) =>
    setForm(f => ({
      ...f,
      selectedGroupIds: f.selectedGroupIds.includes(id)
        ? f.selectedGroupIds.filter(x => x !== id)
        : [...f.selectedGroupIds, id],
    }));

  const toggleAccount = (id: string) =>
    setForm(f => ({
      ...f,
      selectedAccountIds: f.selectedAccountIds.includes(id)
        ? f.selectedAccountIds.filter(x => x !== id)
        : [...f.selectedAccountIds, id],
    }));

  const selectAllGroups = () => setForm(f => ({
    ...f, selectedGroupIds: filteredGroups.map(g => g.id)
  }));

  const validateStep = () => {
    setError('');
    if (step === 1 && !form.name.trim()) { setError('يرجى إدخال اسم الحملة'); return false; }
    if (step === 1 && !form.messageText.trim()) { setError('يرجى إدخال نص الرسالة'); return false; }
    if (step === 2 && form.selectedGroupIds.length === 0) { setError('يرجى اختيار مجموعة واحدة على الأقل'); return false; }
    if (step === 3 && form.selectedAccountIds.length === 0) { setError('يرجى اختيار حساب واحد على الأقل'); return false; }
    if (step === 4 && form.scheduleMode === 'later') {
      if (!form.startTime) { setError('يرجى تحديد وقت البداية'); return false; }
      if (!form.endTime) { setError('يرجى تحديد وقت الانتهاء'); return false; }
      if (new Date(form.endTime) <= new Date(form.startTime)) {
        setError('وقت الانتهاء يجب أن يكون بعد وقت البداية'); return false;
      }
    }
    return true;
  };

  const handleNext = () => {
    if (!validateStep()) return;
    setStep(s => s + 1);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError('');
    try {
      const payload = {
        name: form.name,
        messageText: form.messageText,
        groupIds: form.selectedGroupIds,
        accountIds: form.selectedAccountIds,
        messagesPerAccount: form.messagesPerAccount,
        intervalSeconds: form.intervalSeconds,
        startTime: form.scheduleMode === 'now' ? new Date().toISOString() : new Date(form.startTime).toISOString(),
        endTime:   form.scheduleMode === 'now' ? new Date(Date.now() + 24*3600*1000).toISOString() : new Date(form.endTime).toISOString(),
        autoStart: form.scheduleMode === 'now',
      };
      const res = await authFetch(`${API}/private-campaigns`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!d.success) { setError(d.error || 'حدث خطأ'); return; }
      onCreated();
      onClose();
    } catch (e) {
      setError('خطأ في الاتصال بالخادم');
    } finally {
      setLoading(false);
    }
  };

  const totalMessages = form.selectedAccountIds.length * form.messagesPerAccount;
  const estimatedDuration = totalMessages > 0
    ? Math.round((totalMessages * form.intervalSeconds) / 60)
    : 0;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl min-h-[560px] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="w-5 h-5 text-[var(--brand-primary)]" />
            حملة نشر جديدة
          </DialogTitle>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-1.5 py-3">
          {WIZARD_STEPS.map((s, i) => (
            <React.Fragment key={s.id}>
              <div className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all',
                step === s.id
                  ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                  : step > s.id
                  ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
              )}>
                {step > s.id
                  ? <Check className="w-3 h-3" />
                  : <s.icon className="w-3 h-3" />
                }
                <span className="hidden sm:inline">{s.label}</span>
              </div>
              {i < WIZARD_STEPS.length - 1 && (
                <div className={cn('w-4 h-px', step > s.id ? 'bg-[var(--brand-primary)]' : 'bg-[var(--border-default)]')} />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Step content */}
        <div className="flex-1 overflow-y-auto py-2">

          {/* ── Step 1: Name & Message ── */}
          {step === 1 && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--text-primary)]">اسم الحملة *</label>
                <input
                  className="input w-full"
                  placeholder="مثال: حملة عروض الصيف 2025..."
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  maxLength={100}
                />
                <p className="text-xs text-[var(--text-muted)] text-left">{form.name.length}/100</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-[var(--text-primary)]">نص الرسالة *</label>
                <textarea
                  className="input w-full min-h-[140px] resize-none"
                  placeholder="اكتب محتوى الرسالة هنا... يمكن استخدام الرموز التعبيرية ✅"
                  value={form.messageText}
                  onChange={e => setForm(f => ({ ...f, messageText: e.target.value }))}
                  maxLength={4096}
                />
                <p className="text-xs text-[var(--text-muted)] text-left">{form.messageText.length}/4096</p>
              </div>
              <div className="flex items-start gap-2 p-3 bg-blue-500/5 border border-blue-500/15 rounded-xl">
                <Info className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
                <p className="text-xs text-blue-400">
                  سيتم إرسال هذه الرسالة مباشرةً إلى المجموعات المختارة، ليست لأعضاء المجموعات بل للمجموعة نفسها كرسالة عامة.
                </p>
              </div>
            </div>
          )}

          {/* ── Step 2: Groups ── */}
          {step === 2 && (
            <div className="space-y-3 animate-fade-in">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-[var(--text-primary)]">
                  اختر المجموعات المستهدفة
                </h3>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="border-[var(--brand-primary)]/30 text-[var(--brand-primary)]">
                    {form.selectedGroupIds.length} مختار
                  </Badge>
                  <button
                    className="text-xs text-[var(--brand-primary)] hover:underline"
                    onClick={selectAllGroups}
                  >
                    تحديد الكل
                  </button>
                  {form.selectedGroupIds.length > 0 && (
                    <button
                      className="text-xs text-[var(--text-muted)] hover:underline"
                      onClick={() => setForm(f => ({ ...f, selectedGroupIds: [] }))}
                    >
                      إلغاء الكل
                    </button>
                  )}
                </div>
              </div>
              <input
                className="input w-full"
                placeholder="بحث عن مجموعة..."
                value={searchGroup}
                onChange={e => setSearchGroup(e.target.value)}
              />
              <div className="border border-[var(--border-default)] rounded-xl overflow-hidden max-h-72 overflow-y-auto">
                {loadingGroups ? (
                  <div className="p-8 text-center text-[var(--text-muted)] text-sm">جارٍ تحميل المجموعات...</div>
                ) : filteredGroups.length === 0 ? (
                  <div className="p-8 text-center text-[var(--text-muted)] text-sm">
                    {searchGroup ? 'لا توجد نتائج' : 'لا توجد مجموعات متاحة'}
                  </div>
                ) : filteredGroups.map(g => {
                  const selected = form.selectedGroupIds.includes(g.id);
                  return (
                    <label
                      key={g.id}
                      className={cn(
                        'flex items-center gap-3 p-3 border-b border-[var(--border-default)] last:border-0 cursor-pointer transition-colors',
                        selected ? 'bg-[var(--brand-primary)]/5' : 'hover:bg-[var(--bg-elevated)]'
                      )}
                      onClick={() => toggleGroup(g.id)}
                    >
                      <div className={cn(
                        'w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all',
                        selected
                          ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)]'
                          : 'border-[var(--border-strong)]'
                      )}>
                        {selected && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm text-[var(--text-primary)] truncate">{g.name || g.group_jid}</p>
                        <p className="text-xs text-[var(--text-muted)]">{g.participants_count?.toLocaleString() || 0} عضو</p>
                      </div>
                      {!g.is_active && (
                        <Badge variant="outline" className="border-red-500/20 text-red-400 text-xs">غير نشطة</Badge>
                      )}
                    </label>
                  );
                })}
              </div>
              <div className="text-xs text-[var(--text-muted)] flex items-center gap-1">
                <Info className="w-3.5 h-3.5" />
                إجمالي: {groups.length} مجموعة متاحة
              </div>
            </div>
          )}

          {/* ── Step 3: Accounts ── */}
          {step === 3 && (
            <div className="space-y-3 animate-fade-in">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-[var(--text-primary)]">
                  اختر الحسابات المستخدمة
                </h3>
                <Badge variant="outline" className="border-[var(--brand-primary)]/30 text-[var(--brand-primary)]">
                  {form.selectedAccountIds.length} مختار
                </Badge>
              </div>
              {connectedAccounts.length === 0 ? (
                <div className="p-8 text-center">
                  <AlertCircle className="w-10 h-10 text-yellow-500 mx-auto mb-2" />
                  <p className="text-sm text-[var(--text-secondary)]">لا توجد حسابات متصلة حالياً</p>
                </div>
              ) : (
                <div className="border border-[var(--border-default)] rounded-xl overflow-hidden">
                  {connectedAccounts.map(acc => {
                    const selected = form.selectedAccountIds.includes(acc.id);
                    return (
                      <label
                        key={acc.id}
                        className={cn(
                          'flex items-center gap-3 p-3.5 border-b border-[var(--border-default)] last:border-0 cursor-pointer transition-colors',
                          selected ? 'bg-[var(--brand-primary)]/5' : 'hover:bg-[var(--bg-elevated)]'
                        )}
                        onClick={() => toggleAccount(acc.id)}
                      >
                        <div className={cn(
                          'w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all',
                          selected ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)]' : 'border-[var(--border-strong)]'
                        )}>
                          {selected && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="w-9 h-9 rounded-xl bg-[var(--bg-elevated)] flex items-center justify-center shrink-0">
                          <Smartphone className="w-4 h-4 text-[var(--brand-primary)]" />
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-sm text-[var(--text-primary)]">{acc.name || acc.phone}</p>
                          <p className="text-xs text-[var(--text-muted)]">{acc.phone}</p>
                        </div>
                        <Badge variant="outline" className="border-0 bg-green-500/10 text-green-500 text-xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block ml-1" />
                          متصل
                        </Badge>
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="space-y-2 pt-2">
                <label className="text-sm font-medium text-[var(--text-primary)]">
                  عدد الرسائل لكل حساب
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={1} max={500} step={1}
                    value={form.messagesPerAccount}
                    onChange={e => setForm(f => ({ ...f, messagesPerAccount: Number(e.target.value) }))}
                    className="flex-1 accent-[var(--brand-primary)]"
                  />
                  <div className="w-20">
                    <input
                      type="number" min={1} max={500}
                      value={form.messagesPerAccount}
                      onChange={e => setForm(f => ({ ...f, messagesPerAccount: Number(e.target.value) }))}
                      className="input w-full text-center text-sm"
                    />
                  </div>
                </div>
                {form.selectedAccountIds.length > 0 && (
                  <div className="flex items-center gap-2 p-2.5 bg-[var(--bg-elevated)] rounded-lg">
                    <TrendingUp className="w-4 h-4 text-[var(--brand-primary)] shrink-0" />
                    <p className="text-xs text-[var(--text-secondary)]">
                      إجمالي الرسائل المتوقعة:
                      <span className="font-bold text-[var(--text-primary)] mx-1">
                        {(form.selectedAccountIds.length * form.messagesPerAccount).toLocaleString()}
                      </span>
                      رسالة
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 4: Timing ── */}
          {step === 4 && (
            <div className="space-y-5 animate-fade-in">
              <div className="space-y-2">
                <h3 className="font-semibold text-[var(--text-primary)]">الفاصل الزمني بين الرسائل</h3>
                <p className="text-xs text-[var(--text-muted)]">
                  وقت الانتظار بين كل رسالة والأخرى لتجنب الحظر
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {[5, 10, 15, 30, 60].map(sec => (
                    <button
                      key={sec}
                      onClick={() => setForm(f => ({ ...f, intervalSeconds: sec }))}
                      className={cn(
                        'p-2.5 rounded-xl border text-sm font-semibold transition-all',
                        form.intervalSeconds === sec
                          ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                          : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]'
                      )}
                    >
                      {sec}ث
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-sm text-[var(--text-secondary)] whitespace-nowrap">أو أدخل يدوياً:</label>
                  <input
                    type="number" min={3} max={3600}
                    value={form.intervalSeconds}
                    onChange={e => setForm(f => ({ ...f, intervalSeconds: Number(e.target.value) }))}
                    className="input w-28"
                  />
                  <span className="text-sm text-[var(--text-muted)]">ثانية</span>
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="font-semibold text-[var(--text-primary)]">وقت التشغيل</h3>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { val: 'now',   label: 'الآن فوراً',     icon: Zap        },
                    { val: 'later', label: 'وقت محدد',       icon: CalendarRange },
                  ].map(opt => (
                    <button
                      key={opt.val}
                      onClick={() => setForm(f => ({ ...f, scheduleMode: opt.val as any }))}
                      className={cn(
                        'flex items-center gap-2.5 p-3.5 rounded-xl border text-sm font-medium transition-all text-right',
                        form.scheduleMode === opt.val
                          ? 'bg-[var(--brand-primary)]/10 border-[var(--brand-primary)] text-[var(--brand-primary)]'
                          : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                      )}
                    >
                      <opt.icon className="w-4 h-4 shrink-0" />
                      {opt.label}
                    </button>
                  ))}
                </div>

                {form.scheduleMode === 'later' && (
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div className="space-y-1">
                      <label className="text-xs text-[var(--text-muted)]">وقت البداية</label>
                      <input
                        type="datetime-local"
                        className="input w-full text-sm"
                        value={form.startTime}
                        onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-[var(--text-muted)]">وقت الانتهاء</label>
                      <input
                        type="datetime-local"
                        className="input w-full text-sm"
                        value={form.endTime}
                        onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Duration estimate */}
              {form.selectedAccountIds.length > 0 && (
                <div className="flex items-center gap-3 p-3.5 bg-[var(--bg-elevated)] rounded-xl border border-[var(--border-default)]">
                  <Clock className="w-5 h-5 text-[var(--brand-primary)] shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">الوقت التقديري للإرسال</p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      {totalMessages.toLocaleString()} رسالة × {form.intervalSeconds}ث ≈
                      <span className="font-bold text-[var(--text-primary)] mx-1">{estimatedDuration}</span>
                      دقيقة
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 5: Review ── */}
          {step === 5 && (
            <div className="space-y-4 animate-fade-in">
              <div className="text-center pb-2">
                <div className="w-14 h-14 rounded-2xl bg-[var(--brand-primary)]/10 flex items-center justify-center mx-auto mb-3">
                  <Rocket className="w-7 h-7 text-[var(--brand-primary)]" />
                </div>
                <h3 className="text-lg font-bold text-[var(--text-primary)]">مراجعة الحملة</h3>
                <p className="text-sm text-[var(--text-muted)]">تأكد من الإعدادات قبل الإطلاق</p>
              </div>

              <div className="bg-[var(--bg-elevated)] rounded-xl border border-[var(--border-default)] divide-y divide-[var(--border-default)] overflow-hidden">
                {[
                  { label: 'اسم الحملة',            val: form.name                            },
                  { label: 'المجموعات المستهدفة',   val: `${form.selectedGroupIds.length} مجموعة` },
                  { label: 'الحسابات المستخدمة',    val: `${form.selectedAccountIds.length} حساب`  },
                  { label: 'رسائل لكل حساب',        val: form.messagesPerAccount.toLocaleString()   },
                  { label: 'إجمالي الرسائل',        val: totalMessages.toLocaleString()             },
                  { label: 'الفاصل الزمني',         val: `${form.intervalSeconds} ثانية`           },
                  { label: 'وقت التشغيل',           val: form.scheduleMode === 'now' ? 'الآن فوراً' : fmtDateTime(form.startTime) },
                  { label: 'وقت الانتهاء',          val: form.scheduleMode === 'now' ? '(تلقائي)' : fmtDateTime(form.endTime) },
                ].map((row, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-sm text-[var(--text-muted)]">{row.label}</span>
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{row.val}</span>
                  </div>
                ))}
              </div>

              <div className="p-3.5 bg-[var(--bg-elevated)] rounded-xl border border-[var(--border-default)]">
                <p className="text-xs font-semibold text-[var(--text-muted)] mb-1.5">معاينة الرسالة</p>
                <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed line-clamp-4">
                  {form.messageText}
                </p>
              </div>

              <div className="flex items-start gap-2 p-3.5 bg-yellow-500/5 border border-yellow-500/15 rounded-xl">
                <AlertCircle className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                <p className="text-xs text-yellow-600 dark:text-yellow-400">
                  بالضغط على &quot;إطلاق الحملة&quot; سيبدأ النظام بإرسال الرسائل وفق الإعدادات المحددة.
                  تأكد من صحة المحتوى قبل المتابعة.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center pt-4 border-t border-[var(--border-default)]">
          <Button
            variant="outline"
            onClick={() => step > 1 ? setStep(s => s - 1) : onClose()}
            disabled={loading}
          >
            {step > 1 ? 'السابق' : 'إلغاء'}
          </Button>
          {step < 5 ? (
            <Button onClick={handleNext}>
              التالي
              <ChevronRight className="w-4 h-4 mr-1" />
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={loading}
              className="bg-[var(--brand-primary)] hover:brightness-110"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <RefreshCcw className="w-4 h-4 animate-spin" />
                  جارٍ الإنشاء...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Rocket className="w-4 h-4" />
                  إطلاق الحملة
                </span>
              )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────
export default function PrivateCampaignsView({
  accountId, accounts = [],
}: {
  accountId: string | null;
  accounts: any[];
}) {
  const [campaigns, setCampaigns] = useState<PrivateCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState<PrivateCampaign | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchCampaigns = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/private-campaigns`);
      const d = await res.json();
      if (d.success) setCampaigns(d.campaigns ?? []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchCampaigns();
    const iv = setInterval(fetchCampaigns, 8000);
    return () => clearInterval(iv);
  }, [fetchCampaigns]);

  const handleStart = async (id: string) => {
    setActionLoading(id);
    try {
      await authFetch(`${API}/private-campaigns/${id}/start`, { method: 'POST' });
      await fetchCampaigns();
    } finally { setActionLoading(null); }
  };

  const handlePause = async (id: string) => {
    setActionLoading(id);
    try {
      await authFetch(`${API}/private-campaigns/${id}/pause`, { method: 'POST' });
      await fetchCampaigns();
    } finally { setActionLoading(null); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذه الحملة؟')) return;
    setActionLoading(id);
    try {
      await authFetch(`${API}/private-campaigns/${id}`, { method: 'DELETE' });
      setCampaigns(c => c.filter(x => x.id !== id));
    } finally { setActionLoading(null); }
  };

  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Rocket className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">
            يجب اختيار حساب واتساب نشط من الشريط العلوي لإدارة حملات النشر الخاص.
          </p>
        </div>
      </div>
    );
  }

  // Stats
  const stats = {
    total:    campaigns.length,
    running:  campaigns.filter(c => c.status === 'running').length,
    scheduled: campaigns.filter(c => c.status === 'scheduled').length,
    completed: campaigns.filter(c => c.status === 'completed').length,
    totalSent: campaigns.reduce((s, c) => s + (c.sent_count ?? 0), 0),
  };

  return (
    <div className="flex flex-col gap-6 h-full">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Rocket className="w-6 h-6 text-[var(--brand-primary)]" />
            حملات النشر الخاص
          </h1>
          <p className="text-[var(--text-secondary)] mt-1 text-sm">
            إدارة حملات الإرسال المتعدد عبر المجموعات والحسابات
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchCampaigns}>
            <RefreshCcw className="w-4 h-4" />
          </Button>
          <Button onClick={() => setShowCreate(true)} className="gap-1.5">
            <Plus className="w-4 h-4" />
            حملة جديدة
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'إجمالي الحملات',  val: stats.total,     icon: BarChart2,   color: 'text-blue-500',   bg: 'bg-blue-500/10'  },
          { label: 'نشطة الآن',       val: stats.running,   icon: Radio,       color: 'text-green-500',  bg: 'bg-green-500/10' },
          { label: 'مجدولة',          val: stats.scheduled, icon: CalendarRange, color: 'text-purple-500', bg: 'bg-purple-500/10' },
          { label: 'مكتملة',          val: stats.completed, icon: Check,       color: 'text-gray-500',   bg: 'bg-gray-500/10'  },
          { label: 'إجمالي الرسائل',  val: stats.totalSent.toLocaleString(), icon: MessageSquare, color: 'text-[var(--brand-primary)]', bg: 'bg-[var(--brand-primary)]/10' },
        ].map((s, i) => (
          <Card key={i} className="card">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', s.bg)}>
                  <s.icon className={cn('w-4 h-4', s.color)} />
                </div>
                {s.label === 'نشطة الآن' && stats.running > 0 && (
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                )}
              </div>
              <p className={cn('text-2xl font-bold', s.color)}>{s.val}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Campaigns List */}
      <Card className="card flex-1 overflow-hidden flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
            <RefreshCcw className="w-5 h-5 animate-spin ml-2" />
            جارٍ التحميل...
          </div>
        ) : campaigns.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center p-8 max-w-sm">
              <div className="w-16 h-16 rounded-2xl bg-[var(--bg-elevated)] flex items-center justify-center mx-auto mb-4">
                <Rocket className="w-8 h-8 text-[var(--text-muted)]" />
              </div>
              <h3 className="text-base font-bold text-[var(--text-primary)]">لا توجد حملات بعد</h3>
              <p className="text-sm text-[var(--text-secondary)] mt-1 mb-4">
                ابدأ بإنشاء أول حملة نشر خاص بك
              </p>
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="w-4 h-4 ml-1" />
                إنشاء حملة
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full">
              <thead className="bg-[var(--bg-elevated)] sticky top-0 z-10">
                <tr className="border-b border-[var(--border-default)]">
                  {['اسم الحملة', 'الأهداف', 'الحسابات', 'التقدم', 'التوقيت', 'الحالة', 'الإجراءات'].map(h => (
                    <th key={h} className="text-right py-3 px-4 text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.map(camp => {
                  const progress = camp.total_targets > 0
                    ? Math.round(((camp.sent_count + camp.failed_count) / camp.total_targets) * 100)
                    : 0;
                  const isLoading = actionLoading === camp.id;
                  return (
                    <tr
                      key={camp.id}
                      className="border-b border-[var(--border-default)] group hover:bg-[var(--bg-elevated)]/50 transition-colors"
                    >
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-[var(--bg-elevated)] flex items-center justify-center shrink-0">
                            <Rocket className={cn(
                              'w-4 h-4',
                              camp.status === 'running' ? 'text-green-500 animate-bounce' : 'text-[var(--brand-primary)]'
                            )} />
                          </div>
                          <div>
                            <p className="font-semibold text-sm text-[var(--text-primary)]">{camp.name}</p>
                            <p className="text-xs text-[var(--text-muted)]">{fmtDateTime(camp.created_at)}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                          <Target className="w-3.5 h-3.5" />
                          {camp.target_groups_count} مجموعة
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
                          <Smartphone className="w-3.5 h-3.5" />
                          {camp.accounts_count} حساب
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">{camp.messages_per_account} رسالة/حساب</p>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="w-32">
                          <div className="flex justify-between text-xs text-[var(--text-muted)] mb-1">
                            <span>{camp.sent_count.toLocaleString()} / {camp.total_targets.toLocaleString()}</span>
                            <span>{progress}%</span>
                          </div>
                          <Progress value={progress} className="h-1.5" />
                          {camp.failed_count > 0 && (
                            <p className="text-xs text-red-400 mt-0.5">{camp.failed_count} فشل</p>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="text-xs text-[var(--text-muted)] space-y-0.5">
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {camp.interval_seconds}ث فاصل
                          </div>
                          <div>{fmtDateTime(camp.start_time)}</div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <StatusBadge status={camp.status} />
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                          <Button
                            variant="ghost" size="icon"
                            className="h-8 w-8 text-blue-400 hover:text-blue-400 hover:bg-blue-400/10"
                            onClick={() => setSelectedCampaign(camp)}
                            title="التفاصيل"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </Button>
                          {(camp.status === 'draft' || camp.status === 'paused' || camp.status === 'scheduled') && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-8 w-8 text-green-500 hover:text-green-500 hover:bg-green-500/10"
                              onClick={() => handleStart(camp.id)}
                              disabled={isLoading}
                              title="تشغيل"
                            >
                              {isLoading ? <RefreshCcw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                            </Button>
                          )}
                          {camp.status === 'running' && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-8 w-8 text-yellow-500 hover:text-yellow-500 hover:bg-yellow-500/10"
                              onClick={() => handlePause(camp.id)}
                              disabled={isLoading}
                              title="إيقاف مؤقت"
                            >
                              {isLoading ? <RefreshCcw className="w-3.5 h-3.5 animate-spin" /> : <Pause className="w-3.5 h-3.5" />}
                            </Button>
                          )}
                          <Button
                            variant="ghost" size="icon"
                            className="h-8 w-8 text-red-500 hover:text-red-500 hover:bg-red-500/10"
                            onClick={() => handleDelete(camp.id)}
                            disabled={isLoading}
                            title="حذف"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Modals */}
      {showCreate && accountId && (
        <CreateCampaignWizard
          accountId={accountId}
          accounts={accounts}
          onClose={() => setShowCreate(false)}
          onCreated={fetchCampaigns}
        />
      )}

      {selectedCampaign && accountId && (
        <CampaignDetailModal
          campaign={selectedCampaign}
          accountId={accountId}
          onClose={() => setSelectedCampaign(null)}
          onStart={handleStart}
          onPause={handlePause}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
