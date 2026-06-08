import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Users, Search, Filter, Download, Send, Bot, Link2,
  BarChart3, Eye, Smartphone, ChevronDown, ChevronUp,
  MessageSquare, Calendar, Crown, Shield, UserCheck,
  Activity, Globe, Hash, Clock, TrendingUp, FileText,
  X, Copy, ExternalLink, Zap, Bell, Star, Phone, Image,
  RefreshCw, AlertCircle, WifiOff, CheckCircle2,
  Video, Paperclip, Megaphone, Lock, Unlock, Settings,
  Timer, RotateCcw, Wifi, ChevronRight, Play, Pause,
  Archive, LayoutGrid, CheckSquare, XSquare, MinusSquare,
  UserMinus, UserX, Upload, Table, ListFilter, Plus, Trash2,
  DatabaseZap, FileSpreadsheet, SendHorizonal, Eye as EyeIcon,
  AlertTriangle, Info
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { API, authFetch } from '@/utils/api';


/* ─────────────── Category Types ─────────────── */
interface GroupCategory {
  label: string;
  count: number;
  groups: WaGroup[];
}
interface GroupCategories {
  publishable:    GroupCategory;
  restricted:     GroupCategory;
  nonPublishable: GroupCategory;
  archived:       GroupCategory;
}
interface CategoryStats {
  total: number; publishable: number; restricted: number;
  nonPublishable: number; archived: number;
  asAdmin: number; totalMembers: number; avgActivity: number;
}

/* ─────────────── Types ─────────────── */
interface WaGroup {
  id:              string;
  group_jid:       string;
  name:            string;
  description:     string;
  owner:           string;
  members_count:   number;
  admins_count:    number;
  announce:        boolean;
  restrict:        boolean;
  creation_ts:     number;
  avatar_url:      string | null;
  is_member:       boolean;
  is_admin:        boolean;
  publish_status:  'green' | 'yellow' | 'red';
  can_send_text:   boolean;
  can_send_images: boolean;
  can_send_video:  boolean;
  can_send_files:  boolean;
  can_send_links:  boolean;
  can_broadcast:   boolean;
  activity_level:  number;
  messages_today:  number;
  last_sync:       string | null;
}

interface WaMember {
  id:    string;
  admin: string | null;
}

interface SyncSettings {
  interval_minutes:  number;
  auto_sync_enabled: boolean;
  last_auto_sync:    string | null;
}

/* ─────────────── الجزء الخامس — أنواع جديدة ─────────────── */
interface AdItem {
  id:      string;
  name:    string;
  content: string;
}

interface ExclusionItem {
  id:      string;
  phone:   string;
  note:    string;
  created_at: string;
}

interface MemberPublishConfig {
  group_jids:        string[];
  account_ids:       string[];
  ad_library_id:     string;
  custom_content:    string;
  send_time:         string;
  interval_seconds:  number;
  exclude_admins:    boolean;
  excluded_numbers:  string[];
}

type ExportFormat = 'csv' | 'excel' | 'txt' | 'db';

/* ─────────────────────────────────────────────────────────────────────────────
   ★ كاش عالمي — يحافظ على البيانات عند مغادرة القسم والعودة إليه
   ─────────────────────────────────────────────────────────────────────────── */
const globalCache = new Map<string, {
  groups:   WaGroup[];
  syncedAt: string | null;
  ts:       number; // وقت آخر تحديث
}>();

/* ─────────────── Helpers ─────────────── */
const SYNC_OPTIONS = [
  { value: 5,   label: 'كل 5 دقائق',  short: '5د'  },
  { value: 15,  label: 'كل 15 دقيقة', short: '15د' },
  { value: 60,  label: 'كل ساعة',     short: '1س'  },
  { value: 0,   label: 'يدوي فقط',    short: 'يدوي'},
];

const FILTERS = [
  { id: 'all',      label: 'جميع المجموعات' },
  { id: 'green',    label: 'يستطيع النشر 🟢' },
  { id: 'yellow',   label: 'مقيد جزئياً 🟡' },
  { id: 'red',      label: 'لا يستطيع النشر 🔴' },
  { id: 'admin',    label: 'أنت مشرف' },
  { id: 'large',    label: 'الكبيرة (+200)' },
  { id: 'announce', label: 'قناة إعلانات' },
];

const GROUP_TABS = [
  { id: 'info',    icon: BarChart3,  label: 'معلومات'  },
  { id: 'publish', icon: Send,       label: 'صلاحيات'  },
  { id: 'members', icon: Users,      label: 'الأعضاء'  },
  { id: 'stats',   icon: TrendingUp, label: 'إحصائيات' },
  { id: 'send',    icon: Megaphone,  label: 'إرسال'    },
  { id: 'auto',    icon: Bot,        label: 'أتمتة'    },
];

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('ar-SA');
}

function formatJid(jid: string): string {
  return jid ? jid.replace('@g.us', '').replace('@s.whatsapp.net', '') : '—';
}

/** كم مضى منذ وقت معيّن — بالعربية */
function timeAgo(iso: string | null): string {
  if (!iso) return 'لم يتم بعد';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)  return `منذ ${diff} ثانية`;
  if (diff < 3600) return `منذ ${Math.floor(diff / 60)} دقيقة`;
  if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} ساعة`;
  return `منذ ${Math.floor(diff / 86400)} يوم`;
}

/* ─────────────── Sub-components ─────────────── */
function StatCard({ icon: Icon, label, value, color }: {
  icon: any; label: string; value: string | number; color: string
}) {
  return (
    <Card className="card">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-[var(--text-secondary)]">{label}</p>
          <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', color + '/10')}>
            <Icon className={cn('w-4 h-4', color)} />
          </div>
        </div>
        <p className={cn('text-2xl font-bold', color)}>{value}</p>
      </CardContent>
    </Card>
  );
}

function ActivityBar({ level }: { level: number }) {
  const color = level >= 70 ? 'bg-green-500' : level >= 40 ? 'bg-yellow-500' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${level}%` }} />
      </div>
      <span className="text-xs text-[var(--text-muted)] w-8">{level}%</span>
    </div>
  );
}

function PublishBadge({ status }: { status: 'green' | 'yellow' | 'red' }) {
  const map = {
    green:  { emoji: '🟢', label: 'يستطيع النشر',    cls: 'bg-green-500/10 text-green-500 border-green-500/20'  },
    yellow: { emoji: '🟡', label: 'مقيد جزئياً',      cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
    red:    { emoji: '🔴', label: 'لا يستطيع النشر',  cls: 'bg-red-500/10 text-red-400 border-red-500/20'        },
  };
  const cfg = map[status] || map.red;
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold border', cfg.cls)}>
      {cfg.emoji} {cfg.label}
    </span>
  );
}

function CapabilityRow({ icon: Icon, label, allowed, color = 'text-[var(--brand-primary)]' }: {
  icon: any; label: string; allowed: boolean; color?: string
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--border-default)] last:border-0">
      <div className="flex items-center gap-2">
        <Icon className={cn('w-4 h-4', allowed ? color : 'text-[var(--text-muted)]')} />
        <span className="text-sm text-[var(--text-secondary)]">{label}</span>
      </div>
      {allowed
        ? <CheckCircle2 className="w-4 h-4 text-green-500" />
        : <X className="w-4 h-4 text-red-400" />}
    </div>
  );
}

/* ─────────────── Sync Settings Panel ─────────────── */
function SyncSettingsPanel({
  accountId,
  settings,
  onSave,
  onClose,
}: {
  accountId: string;
  settings: SyncSettings;
  onSave: (s: SyncSettings) => void;
  onClose: () => void;
}) {
  const [interval, setInterval_]   = useState(settings.interval_minutes);
  const [enabled,  setEnabled]     = useState(settings.auto_sync_enabled);
  const [saving,   setSaving]      = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/groups/sync-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval_minutes: interval, auto_sync_enabled: enabled }),
      });
      const data = await res.json();
      if (data.success) {
        onSave({ interval_minutes: interval, auto_sync_enabled: enabled, last_auto_sync: settings.last_auto_sync });
        onClose();
      }
    } catch {}
    finally { setSaving(false); }
  };

  return (
    <div className="absolute top-full left-0 mt-2 w-72 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-2xl shadow-2xl z-50 p-4" dir="rtl">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Timer className="w-4 h-4 text-[var(--brand-primary)]" />
          <span className="font-bold text-sm text-[var(--text-primary)]">إعدادات المزامنة</span>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-[var(--bg-elevated)]">
          <X className="w-4 h-4 text-[var(--text-muted)]" />
        </button>
      </div>

      {/* تفعيل/إيقاف */}
      <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--bg-elevated)] mb-3">
        <div>
          <p className="text-sm font-medium text-[var(--text-primary)]">المزامنة التلقائية</p>
          <p className="text-xs text-[var(--text-muted)]">تحديث المجموعات تلقائياً</p>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          className={cn(
            'w-11 h-6 rounded-full transition-all relative',
            enabled ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-overlay)]'
          )}
        >
          <div className={cn(
            'absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm',
            enabled ? 'right-1' : 'left-1'
          )} />
        </button>
      </div>

      {/* الفاصل الزمني */}
      <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2">الفاصل الزمني</p>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {SYNC_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setInterval_(opt.value)}
            disabled={!enabled}
            className={cn(
              'px-3 py-2 rounded-xl text-xs font-medium transition-all border',
              interval === opt.value && enabled
                ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)] shadow-[var(--shadow-glow)]'
                : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border-default)]',
              !enabled && 'opacity-40 cursor-not-allowed'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* آخر مزامنة تلقائية */}
      {settings.last_auto_sync && (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-[var(--bg-elevated)] mb-3">
          <Clock className="w-3 h-3 text-[var(--text-muted)]" />
          <span className="text-xs text-[var(--text-muted)]">
            آخر مزامنة تلقائية: {timeAgo(settings.last_auto_sync)}
          </span>
        </div>
      )}

      <Button onClick={handleSave} disabled={saving} className="w-full gap-2" size="sm">
        {saving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
        {saving ? 'جاري الحفظ...' : 'حفظ الإعدادات'}
      </Button>
    </div>
  );
}

/* ─────────────── Modal Tabs ─────────────── */
function TabInfo({ group }: { group: WaGroup }) {
  const rows = [
    { label: 'اسم المجموعة',    value: group.name,                              mono: false },
    { label: 'معرّف المجموعة',  value: formatJid(group.group_jid),              mono: true  },
    { label: 'الوصف',           value: group.description || '—',                mono: false },
    { label: 'تاريخ الإنشاء',   value: formatDate(group.creation_ts),           mono: false },
    { label: 'المالك',          value: formatJid(group.owner),                  mono: true  },
    { label: 'عدد الأعضاء',     value: group.members_count.toLocaleString(),    mono: false },
    { label: 'عدد المشرفين',    value: group.admins_count,                       mono: false },
    { label: 'نوع المجموعة',    value: group.announce ? 'قناة إعلانات' : 'مجموعة عامة', mono: false },
    { label: 'دورك',            value: group.is_admin ? 'مشرف' : 'عضو',         mono: false },
    { label: 'آخر مزامنة',      value: group.last_sync ? timeAgo(group.last_sync) : '—', mono: false },
  ];

  return (
    <div className="flex flex-col gap-1">
      {rows.map((r, i) => (
        <div key={i} className="flex justify-between items-start py-2.5 border-b border-[var(--border-default)] last:border-0">
          <span className="text-sm text-[var(--text-secondary)] shrink-0">{r.label}</span>
          <span className={cn(
            'text-sm font-medium text-right max-w-[60%] break-all',
            r.mono ? 'font-mono text-[var(--brand-primary)] text-xs' : 'text-[var(--text-primary)]'
          )}>
            {String(r.value)}
          </span>
        </div>
      ))}
      <div className="mt-3">
        <p className="text-xs text-[var(--text-secondary)] mb-2">مستوى النشاط</p>
        <ActivityBar level={group.activity_level} />
      </div>
    </div>
  );
}

function TabPublish({ group }: { group: WaGroup }) {
  return (
    <div className="flex flex-col gap-4">
      <div className={cn(
        'p-4 rounded-2xl border-2',
        group.publish_status === 'green'  ? 'bg-green-500/5 border-green-500/20'  :
        group.publish_status === 'yellow' ? 'bg-yellow-500/5 border-yellow-500/20' :
                                             'bg-red-500/5 border-red-500/20'
      )}>
        <div className="flex items-center gap-3 mb-2">
          <span className="text-2xl">
            {group.publish_status === 'green' ? '🟢' : group.publish_status === 'yellow' ? '🟡' : '🔴'}
          </span>
          <div>
            <p className="font-bold text-[var(--text-primary)]">
              {group.publish_status === 'green'  ? 'يستطيع النشر بحرية'  :
               group.publish_status === 'yellow' ? 'مقيد — أنت مشرف فقط' :
                                                    'لا يستطيع النشر'}
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {group.announce
                ? (group.is_admin ? 'مجموعة إعلانات — يمكنك النشر كمشرف' : 'مجموعة إعلانات — فقط المشرفون يرسلون')
                : 'مجموعة عامة — الجميع يستطيع الإرسال'}
            </p>
          </div>
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2 uppercase tracking-wider">أنواع المحتوى</p>
        <div className="bg-[var(--bg-elevated)] rounded-2xl px-4">
          <CapabilityRow icon={MessageSquare} label="نشر نصوص"          allowed={group.can_send_text}   />
          <CapabilityRow icon={Image}         label="نشر صور"            allowed={group.can_send_images} />
          <CapabilityRow icon={Video}         label="نشر فيديو"          allowed={group.can_send_video}  />
          <CapabilityRow icon={Paperclip}     label="نشر ملفات"          allowed={group.can_send_files}  />
          <CapabilityRow icon={Link2}         label="نشر روابط"          allowed={group.can_send_links}  />
          <CapabilityRow icon={Megaphone}     label="رسائل جماعية (بث)" allowed={group.can_broadcast}   color="text-purple-400" />
        </div>
      </div>
      {!group.can_send_text && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/5 border border-red-500/15">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-400">
            هذه المجموعة في وضع الإعلانات وأنت لست مشرفاً. لا يمكن النشر فيها.
          </p>
        </div>
      )}
    </div>
  );
}

function TabMembers({ group, accountId }: { group: WaGroup; accountId: string }) {
  const [members, setMembers] = useState<WaMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError  ] = useState<string|null>(null);
  const [search,  setSearch ] = useState('');
  const [filter,  setFilter ] = useState<'all'|'admin'|'member'>('all');
  const [saving,  setSaving ] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string|null>(null);
  const [showSaveMenu, setShowSaveMenu] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`${API}/accounts/${accountId}/groups/${encodeURIComponent(group.group_jid)}/members`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.success) {
          const all: WaMember[] = [
            ...(d.admins || []).map((id: string) => ({ id, admin: 'admin' })),
            ...(d.target_jids || []).map((id: string) => ({ id, admin: null })),
          ];
          setMembers(all);
        } else { setError(d.error || 'فشل جلب الأعضاء'); }
      })
      .catch(() => { if (!cancelled) setError('خطأ في الاتصال'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [group.group_jid, accountId]);

  const shown = useMemo(() => members.filter(m => {
    if (filter === 'admin'  && !m.admin) return false;
    if (filter === 'member' && m.admin)  return false;
    if (search && !m.id.includes(search)) return false;
    return true;
  }), [members, filter, search]);

  /* ── تصدير الأعضاء ── */
  const handleExport = async (format: ExportFormat) => {
    setSaving(true);
    setSaveMsg(null);
    setShowSaveMenu(false);
    try {
      if (format === 'db') {
        // حفظ في قاعدة البيانات عبر endpoint
        const res  = await authFetch(
          `${API}/accounts/${accountId}/groups/${encodeURIComponent(group.group_jid)}/members/export?format=json`
        );
        const data = await res.json();
        if (data.success) {
          setSaveMsg(`✅ تم حفظ ${data.count} عضو في قاعدة البيانات`);
        } else {
          setSaveMsg(`❌ ${data.error}`);
        }
        return;
      }

      if (format === 'excel') {
        // جلب البيانات ثم بناء CSV/Excel في المتصفح
        const res  = await authFetch(
          `${API}/accounts/${accountId}/groups/${encodeURIComponent(group.group_jid)}/members/export?format=json`
        );
        const data = await res.json();
        if (!data.success) { setSaveMsg(`❌ ${data.error}`); return; }

        // بناء CSV مع BOM لـ Excel
        const header = 'الرقم,الدور,اسم المجموعة,تاريخ الاستخراج\n';
        const rows   = data.members.map((m: any) =>
          `${m.phone},${m.role},"${m.group_name}",${m.extracted_at}`
        ).join('\n');
        const blob = new Blob(['\ufeff' + header + rows], { type: 'text/csv;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `members_${group.name}_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        setSaveMsg(`✅ تم تصدير ${data.count} عضو`);
        return;
      }

      // CSV / TXT — تحميل مباشر من السيرفر
      const exportUrl = `${API}/accounts/${accountId}/groups/${encodeURIComponent(group.group_jid)}/members/export?format=${format}`;
      const token     = localStorage.getItem('auth_token') || '';
      const res       = await fetch(exportUrl, { headers: { Authorization: `Bearer ${token}` } });

      if (!res.ok) { setSaveMsg('❌ فشل التصدير'); return; }

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const ext  = format === 'txt' ? 'txt' : 'csv';
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `members_${group.name}_${Date.now()}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      setSaveMsg(`✅ تم تصدير الأعضاء`);
    } catch (e: any) {
      setSaveMsg(`❌ ${e.message || 'خطأ'}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="flex flex-col gap-2">
      {[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-[var(--bg-elevated)] rounded-xl animate-pulse" />)}
    </div>
  );
  if (error) return (
    <div className="flex items-center gap-2 p-4 rounded-xl bg-red-500/5 border border-red-500/15">
      <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
      <p className="text-sm text-red-400">{error}</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* ── شريط الأدوات ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input className="input pr-9 w-full" placeholder="بحث برقم الهاتف..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        {/* زر حفظ الأعضاء */}
        <div className="relative">
          <Button
            size="sm"
            onClick={() => setShowSaveMenu(!showSaveMenu)}
            disabled={saving || members.length === 0}
            className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white border-0"
          >
            {saving
              ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              : <Download className="w-3.5 h-3.5" />
            }
            حفظ جميع الأعضاء
            <ChevronDown className={cn('w-3 h-3 transition-transform', showSaveMenu && 'rotate-180')} />
          </Button>

          {showSaveMenu && (
            <div className="absolute top-full left-0 mt-1.5 w-52 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-2xl shadow-2xl z-50 p-2" dir="rtl">
              <p className="text-[10px] font-semibold text-[var(--text-muted)] px-2 pb-1.5 pt-0.5 uppercase tracking-wider">اختر صيغة الحفظ</p>
              {[
                { fmt: 'csv'   as ExportFormat, icon: FileText,        label: 'CSV',             desc: 'جدول بيانات عام'     },
                { fmt: 'excel' as ExportFormat, icon: FileSpreadsheet, label: 'Excel',           desc: 'ملف إكسل مع ترميز عربي' },
                { fmt: 'txt'   as ExportFormat, icon: FileText,        label: 'TXT',             desc: 'أرقام نصية فقط'      },
                { fmt: 'db'    as ExportFormat, icon: DatabaseZap,     label: 'قاعدة البيانات', desc: 'حفظ في السيرفر'       },
              ].map(opt => (
                <button key={opt.fmt} onClick={() => handleExport(opt.fmt)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[var(--bg-elevated)] transition-colors text-right">
                  <opt.icon className="w-4 h-4 text-[var(--brand-primary)] shrink-0" />
                  <div>
                    <p className="text-sm font-bold text-[var(--text-primary)]">{opt.label}</p>
                    <p className="text-[10px] text-[var(--text-muted)]">{opt.desc}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* رسالة الحفظ */}
      {saveMsg && (
        <div className={cn(
          'flex items-center gap-2 p-2.5 rounded-xl text-xs font-medium',
          saveMsg.startsWith('✅') ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'
        )}>
          {saveMsg}
          <button onClick={() => setSaveMsg(null)} className="mr-auto"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* فلاتر */}
      <div className="flex gap-1">
        {[
          { id: 'all',    label: `الجميع (${members.length})` },
          { id: 'admin',  label: `المشرفون (${members.filter(m=>m.admin).length})` },
          { id: 'member', label: 'الأعضاء' },
        ].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id as any)}
            className={cn('px-3 py-1 rounded-lg text-xs font-medium transition-colors',
              filter === f.id ? 'bg-[var(--brand-primary)] text-white' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]')}>
            {f.label}
          </button>
        ))}
      </div>

      {/* قائمة الأعضاء */}
      <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
        {shown.length === 0
          ? <p className="text-sm text-[var(--text-muted)] text-center py-4">لا توجد نتائج</p>
          : shown.map((m, i) => {
              const phone   = m.id.split('@')[0].replace(/:/g, '');
              const isAdmin = !!m.admin;
              return (
                <div key={i} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--bg-elevated)] transition-colors">
                  <div className={cn('w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
                    isAdmin ? 'bg-[var(--brand-primary)]/20 text-[var(--brand-primary)]' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]')}>
                    {isAdmin ? <Crown className="w-3.5 h-3.5" /> : <Users className="w-3.5 h-3.5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono text-[var(--text-primary)]">+{phone}</p>
                    {isAdmin && <p className="text-[10px] text-[var(--brand-primary)]">{m.admin === 'superadmin' ? 'مشرف رئيسي' : 'مشرف'}</p>}
                  </div>
                  <button onClick={() => navigator.clipboard?.writeText('+' + phone)} className="p-1 rounded hover:bg-[var(--bg-overlay)]">
                    <Copy className="w-3 h-3 text-[var(--text-muted)]" />
                  </button>
                </div>
              );
            })}
      </div>

      <p className="text-[10px] text-[var(--text-muted)] text-center">
        إجمالي {members.length} عضو · {members.filter(m=>m.admin).length} مشرف
      </p>
    </div>
  );
}

function TabStats({ group }: { group: WaGroup }) {
  const memberCount  = group.members_count;
  const adminCount   = group.admins_count;
  const membersPct   = memberCount > 0 ? Math.round((adminCount / memberCount) * 100) : 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'الأعضاء',  value: memberCount.toLocaleString() },
          { label: 'المشرفون', value: adminCount },
          { label: 'النشاط',   value: `${group.activity_level}%` },
        ].map((s, i) => (
          <div key={i} className="bg-[var(--bg-elevated)] rounded-xl p-3 text-center">
            <p className="text-lg font-bold text-[var(--brand-primary)]">{s.value}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>
      <div>
        <p className="text-xs font-medium text-[var(--text-secondary)] mb-3">نسبة المشرفين إلى الأعضاء</p>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-3 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
            <div className="h-full bg-[var(--brand-primary)] rounded-full" style={{ width: `${membersPct}%` }} />
          </div>
          <span className="text-xs text-[var(--text-muted)] w-8">{membersPct}%</span>
        </div>
      </div>
      <div>
        <p className="text-xs font-medium text-[var(--text-secondary)] mb-2">معلومات إضافية</p>
        <div className="flex flex-col gap-1 bg-[var(--bg-elevated)] rounded-2xl px-4 py-2">
          {[
            { label: 'نوع المجموعة', value: group.announce ? 'قناة إعلانات' : 'مجموعة عامة' },
            { label: 'الإعدادات',    value: group.restrict  ? 'مقيدة'         : 'مفتوحة'     },
            { label: 'دورك',         value: group.is_admin  ? '👑 مشرف'        : '👤 عضو'     },
            { label: 'تاريخ الإنشاء', value: formatDate(group.creation_ts) },
          ].map((r, i) => (
            <div key={i} className="flex justify-between py-2 border-b border-[var(--border-default)] last:border-0">
              <span className="text-xs text-[var(--text-muted)]">{r.label}</span>
              <span className="text-xs font-medium text-[var(--text-primary)]">{r.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TabSend({ group }: { group: WaGroup }) {
  const [msgType, setMsgType] = useState('text');
  const canSend = group.can_send_text;
  const types = [
    { id: 'text',     icon: MessageSquare, label: 'نص',    allowed: group.can_send_text   },
    { id: 'image',    icon: Image,         label: 'صورة',  allowed: group.can_send_images },
    { id: 'video',    icon: Video,         label: 'فيديو', allowed: group.can_send_video  },
    { id: 'file',     icon: FileText,      label: 'ملف',   allowed: group.can_send_files  },
    { id: 'schedule', icon: Calendar,      label: 'مجدول', allowed: canSend              },
  ];
  if (!canSend) return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center">
        <Lock className="w-7 h-7 text-red-400" />
      </div>
      <p className="font-bold text-[var(--text-primary)]">لا يمكن الإرسال</p>
      <p className="text-sm text-[var(--text-muted)] max-w-[220px]">
        هذه مجموعة إعلانات وأنت لست مشرفاً.
      </p>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 flex-wrap">
        {types.map(t => (
          <button key={t.id} onClick={() => t.allowed && setMsgType(t.id)} disabled={!t.allowed}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              !t.allowed ? 'opacity-30 cursor-not-allowed bg-[var(--bg-elevated)] text-[var(--text-muted)]' :
              msgType===t.id ? 'bg-[var(--brand-primary)] text-white' :
                               'bg-[var(--bg-elevated)] text-[var(--text-secondary)]')}>
            <t.icon className="w-3 h-3" />{t.label}
          </button>
        ))}
      </div>
      {(msgType === 'text' || msgType === 'schedule') && (
        <textarea className="input w-full min-h-28 resize-none" placeholder="اكتب رسالتك هنا..." />
      )}
      {msgType === 'image' && (
        <div className="border-2 border-dashed border-[var(--border-strong)] rounded-xl p-8 text-center">
          <Image className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-2" />
          <p className="text-sm text-[var(--text-secondary)]">اسحب صورة أو <span className="text-[var(--brand-primary)] cursor-pointer">اختر ملف</span></p>
        </div>
      )}
      {msgType === 'schedule' && <input type="datetime-local" className="input" />}
      <Button className="w-full gap-2"><Send className="w-4 h-4" />إرسال للمجموعة</Button>
    </div>
  );
}

function TabAuto({ group }: { group: WaGroup }) {
  const canAutomate = group.is_admin;
  const automations = [
    { id: 'links',   icon: Link2,         label: 'مراقبة الروابط',    desc: 'رصد وحذف الروابط المحظورة', enabled: false, needsAdmin: true  },
    { id: 'reply',   icon: MessageSquare, label: 'الرد التلقائي',     desc: 'الرد على كلمات مفتاحية',    enabled: false, needsAdmin: false },
    { id: 'welcome', icon: Bell,          label: 'الترحيب التلقائي',  desc: 'رسالة ترحيب للأعضاء الجدد', enabled: false, needsAdmin: true  },
    { id: 'spam',    icon: Shield,        label: 'الحماية من السبام', desc: 'حذف الرسائل المزعجة',       enabled: false, needsAdmin: true  },
    { id: 'filter',  icon: Filter,        label: 'فلترة الكلمات',     desc: 'منع كلمات معينة',            enabled: false, needsAdmin: true  },
  ];
  const [states, setStates] = useState(() =>
    Object.fromEntries(automations.map(a => [a.id, a.enabled]))
  );
  return (
    <div className="flex flex-col gap-2">
      {!canAutomate && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-yellow-500/5 border border-yellow-500/20 mb-1">
          <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
          <p className="text-xs text-yellow-400">بعض الأتمتة تحتاج صلاحية مشرف.</p>
        </div>
      )}
      {automations.map(a => {
        const locked = a.needsAdmin && !canAutomate;
        return (
          <div key={a.id} className={cn('flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]', locked && 'opacity-50')}>
            <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
              <a.icon className="w-4 h-4 text-[var(--brand-primary)]" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-bold text-[var(--text-primary)]">{a.label}</p>
              <p className="text-xs text-[var(--text-muted)]">{a.desc}</p>
            </div>
            <button disabled={locked}
              onClick={() => !locked && setStates(s => ({ ...s, [a.id]: !s[a.id] }))}
              className={cn('w-11 h-6 rounded-full transition-all relative shrink-0',
                states[a.id] ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-overlay)]',
                locked && 'cursor-not-allowed')}>
              <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm',
                states[a.id] ? 'right-1' : 'left-1')} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────── Group Avatar ─────────────── */
function GroupAvatar({ group, size = 'md' }: { group: WaGroup; size?: 'sm' | 'md' | 'lg' }) {
  const [imgError, setImgError] = useState(false);
  const sizeMap = { sm: 'w-10 h-10 text-xs', md: 'w-12 h-12 text-sm', lg: 'w-14 h-14 text-base' };
  const initials = group.name.split(' ').slice(0, 2).map(w => w[0]).join('');
  if (group.avatar_url && !imgError) {
    return (
      <img src={group.avatar_url} alt={group.name} onError={() => setImgError(true)}
        className={cn('rounded-2xl object-cover shrink-0', sizeMap[size])} />
    );
  }
  return (
    <div className={cn(
      'rounded-2xl bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-secondary)] flex items-center justify-center text-white font-bold shrink-0',
      sizeMap[size]
    )}>
      {initials}
    </div>
  );
}

/* ─────────────── Group Card ─────────────── */
function GroupCard({ group, onClick }: { group: WaGroup; onClick: () => void }) {
  return (
    <div onClick={onClick}
      className="card p-4 cursor-pointer hover:border-[var(--brand-primary)]/40 transition-all hover:-translate-y-0.5 group">
      <div className="flex items-start gap-3 mb-3">
        <GroupAvatar group={group} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="font-bold text-[var(--text-primary)] text-sm leading-snug line-clamp-2">{group.name}</p>
            <PublishBadge status={group.publish_status} />
          </div>
          {group.description && (
            <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-1">{group.description}</p>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { icon: Users,    value: group.members_count.toLocaleString(), label: 'عضو'  },
          { icon: Crown,    value: group.admins_count,                    label: 'مشرف' },
          { icon: Activity, value: `${group.activity_level}%`,           label: 'نشاط' },
        ].map((s, i) => (
          <div key={i} className="bg-[var(--bg-elevated)] rounded-xl p-2 text-center">
            <s.icon className="w-3.5 h-3.5 text-[var(--brand-primary)] mx-auto mb-1" />
            <p className="text-sm font-bold text-[var(--text-primary)]">{s.value}</p>
            <p className="text-[10px] text-[var(--text-muted)]">{s.label}</p>
          </div>
        ))}
      </div>
      <ActivityBar level={group.activity_level} />
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--border-default)]">
        <div className="flex items-center gap-2">
          {group.is_admin && (
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
              👑 مشرف
            </span>
          )}
          {group.announce && (
            <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-yellow-500/10 text-yellow-400">
              📢 إعلانات
            </span>
          )}
        </div>
        <span className="text-xs font-medium text-[var(--brand-primary)] opacity-0 group-hover:opacity-100 transition-opacity">
          عرض التفاصيل ←
        </span>
      </div>
    </div>
  );
}

/* ─────────────── مودال إدارة قائمة الاستثناءات ─────────────── */
function ExclusionManagerModal({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const [exclusions, setExclusions] = useState<ExclusionItem[]>([]);
  const [loading,    setLoading   ] = useState(true);
  const [input,      setInput     ] = useState('');
  const [note,       setNote      ] = useState('');
  const [msg,        setMsg       ] = useState<string|null>(null);
  const [importing,  setImporting ] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/groups/exclusions`);
      const data = await res.json();
      if (data.success) setExclusions(data.exclusions || []);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [accountId]);

  const handleAdd = async () => {
    const numbers = input.split(/[\n,،\s]+/).filter(Boolean);
    if (numbers.length === 0) return;
    const res  = await authFetch(`${API}/accounts/${accountId}/groups/exclusions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers, note }),
    });
    const data = await res.json();
    setMsg(data.success ? data.message : `❌ ${data.error}`);
    if (data.success) { setInput(''); setNote(''); load(); }
  };

  const handleDelete = async (id: string) => {
    await authFetch(`${API}/accounts/${accountId}/groups/exclusions/${id}`, { method: 'DELETE' });
    setExclusions(prev => prev.filter(e => e.id !== id));
  };

  const handleClear = async () => {
    if (!confirm('هل أنت متأكد من مسح كل الاستثناءات؟')) return;
    await authFetch(`${API}/accounts/${accountId}/groups/exclusions`, { method: 'DELETE' });
    setExclusions([]);
    setMsg('✅ تم مسح القائمة');
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    const text = await file.text();
    const numbers = text.split(/[\n,،\r]+/).map(s => s.trim()).filter(Boolean);
    const res  = await authFetch(`${API}/accounts/${accountId}/groups/exclusions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers, note: `استيراد من ملف: ${file.name}` }),
    });
    const data = await res.json();
    setMsg(data.success ? `✅ استُورد ${numbers.length} رقم` : `❌ ${data.error}`);
    if (data.success) load();
    setImporting(false);
    e.target.value = '';
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md flex flex-col max-h-[85vh]" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserMinus className="w-5 h-5 text-red-400" />
            إدارة قائمة الاستثناءات
          </DialogTitle>
        </DialogHeader>

        {/* إضافة يدوية */}
        <div className="flex flex-col gap-2 p-3 bg-[var(--bg-elevated)] rounded-2xl">
          <p className="text-xs font-semibold text-[var(--text-secondary)]">إضافة أرقام (مفصولة بفاصلة أو سطر جديد)</p>
          <textarea
            className="input w-full min-h-20 resize-none text-sm font-mono"
            placeholder="+966501234567&#10;966502345678&#10;05xxxxxxxx"
            value={input}
            onChange={e => setInput(e.target.value)}
          />
          <input
            className="input w-full text-sm"
            placeholder="ملاحظة (اختياري)"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd} className="flex-1 gap-1.5">
              <Plus className="w-3.5 h-3.5" />إضافة
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={importing} className="gap-1.5">
              <Upload className="w-3.5 h-3.5" />
              {importing ? 'جاري...' : 'استيراد ملف'}
            </Button>
            <input ref={fileRef} type="file" accept=".txt,.csv" className="hidden" onChange={handleImportFile} />
          </div>
        </div>

        {msg && (
          <div className={cn('p-2.5 rounded-xl text-xs font-medium flex items-center gap-2',
            msg.startsWith('✅') ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400')}>
            {msg}
            <button onClick={() => setMsg(null)} className="mr-auto"><X className="w-3 h-3" /></button>
          </div>
        )}

        {/* القائمة */}
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-[var(--text-secondary)]">
            الأرقام المستثناة ({exclusions.length})
          </p>
          {exclusions.length > 0 && (
            <button onClick={handleClear} className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1">
              <Trash2 className="w-3 h-3" />مسح الكل
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-1">
          {loading ? (
            [...Array(3)].map((_, i) => <div key={i} className="h-10 bg-[var(--bg-elevated)] rounded-xl animate-pulse" />)
          ) : exclusions.length === 0 ? (
            <div className="text-center py-6 text-[var(--text-muted)]">
              <UserX className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">لا توجد أرقام مستثناة</p>
            </div>
          ) : (
            exclusions.map(ex => (
              <div key={ex.id} className="flex items-center gap-3 p-2.5 bg-[var(--bg-elevated)] rounded-xl">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-[var(--text-primary)]">+{ex.phone}</p>
                  {ex.note && <p className="text-[10px] text-[var(--text-muted)] truncate">{ex.note}</p>}
                </div>
                <button onClick={() => handleDelete(ex.id)} className="p-1 rounded hover:bg-red-500/10">
                  <X className="w-3.5 h-3.5 text-red-400" />
                </button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────── مودال النشر إلى أعضاء المجموعات ─────────────── */
function MemberPublishModal({
  accountId,
  groups,
  onClose,
}: {
  accountId: string;
  groups:    WaGroup[];
  onClose:   () => void;
}) {
  const [step, setStep] = useState<1|2|3>(1); // 1=إعداد, 2=معاينة, 3=نتيجة
  const [sending, setSending] = useState(false);
  const [result,  setResult ] = useState<any>(null);
  const [showExManager, setShowExManager] = useState(false);

  // الإعدادات
  const [selectedGroups,   setSelectedGroups  ] = useState<string[]>([]);
  const [excludeAdmins,    setExcludeAdmins   ] = useState(false);
  const [customContent,    setCustomContent   ] = useState('');
  const [adId,             setAdId            ] = useState('');
  const [ads,              setAds             ] = useState<AdItem[]>([]);
  const [intervalSec,      setIntervalSec     ] = useState(3);
  const [sendTime,         setSendTime        ] = useState('');
  const [exclusionCount,   setExclusionCount  ] = useState(0);

  // معاينة الأعضاء
  const [previewLoading,   setPreviewLoading  ] = useState(false);
  const [previewTargets,   setPreviewTargets  ] = useState<any[]>([]);
  const [previewError,     setPreviewError    ] = useState<string|null>(null);

  // جلب الإعلانات
  useEffect(() => {
    authFetch(`${API}/accounts/${accountId}/ad-library`)
      .then(r => r.json())
      .then(d => { if (d.success) setAds(d.ads || []); })
      .catch(() => {});
  }, [accountId]);

  // جلب عدد الاستثناءات
  useEffect(() => {
    authFetch(`${API}/accounts/${accountId}/groups/exclusions`)
      .then(r => r.json())
      .then(d => { if (d.success) setExclusionCount(d.exclusions?.length || 0); })
      .catch(() => {});
  }, [accountId, showExManager]);

  const publishableGroups = useMemo(() =>
    groups.filter(g => g.publish_status !== 'red'),
    [groups]
  );

  const toggleGroup = (jid: string) => {
    setSelectedGroups(prev =>
      prev.includes(jid) ? prev.filter(j => j !== jid) : [...prev, jid]
    );
  };

  const selectAll = () => setSelectedGroups(publishableGroups.map(g => g.group_jid));
  const clearAll  = () => setSelectedGroups([]);

  const handlePreview = async () => {
    if (selectedGroups.length === 0) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/groups/members/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_jids:       selectedGroups,
          exclude_admins:   excludeAdmins,
          excluded_numbers: [],
        }),
      });
      const data = await res.json();
      if (data.success) {
        setPreviewTargets(data.targets || []);
        setStep(2);
      } else {
        setPreviewError(data.error || 'فشل جلب المعاينة');
      }
    } catch (e: any) {
      setPreviewError(e.message || 'خطأ في الاتصال');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSend = async () => {
    if (!customContent && !adId) return;
    setSending(true);
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/groups/members/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_jids:       selectedGroups,
          account_ids:      [accountId],
          ad_library_id:    adId || undefined,
          custom_content:   customContent,
          send_time:        sendTime || undefined,
          interval_seconds: intervalSec,
          exclude_admins:   excludeAdmins,
          excluded_numbers: [],
        }),
      });
      const data = await res.json();
      setResult(data);
      setStep(3);
    } catch (e: any) {
      setResult({ success: false, error: e.message });
      setStep(3);
    } finally {
      setSending(false);
    }
  };

  /* ── حساب التقدير الزمني ── */
  const estimatedMinutes = Math.ceil((previewTargets.length * intervalSec) / 60);

  return (
    <>
      <Dialog open onOpenChange={onClose}>
        <DialogContent className="max-w-2xl flex flex-col max-h-[92vh]" dir="rtl">
          <DialogHeader className="pb-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              <div className="w-8 h-8 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
                <SendHorizonal className="w-4 h-4 text-[var(--brand-primary)]" />
              </div>
              النشر إلى أعضاء المجموعات
            </DialogTitle>
            {/* شريط الخطوات */}
            <div className="flex items-center gap-2 pt-2">
              {[
                { n: 1, label: 'الإعداد'   },
                { n: 2, label: 'معاينة'    },
                { n: 3, label: 'النتيجة'   },
              ].map((s, i) => (
                <React.Fragment key={s.n}>
                  <div className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold transition-all',
                    step === s.n
                      ? 'bg-[var(--brand-primary)] text-white'
                      : step > s.n
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
                  )}>
                    {step > s.n ? <CheckCircle2 className="w-3 h-3" /> : <span>{s.n}</span>}
                    {s.label}
                  </div>
                  {i < 2 && <div className="flex-1 h-px bg-[var(--border-default)]" />}
                </React.Fragment>
              ))}
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto">

            {/* ══════ الخطوة 1: الإعداد ══════ */}
            {step === 1 && (
              <div className="flex flex-col gap-4 pt-2">

                {/* اختيار المجموعات */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-1.5">
                      <Users className="w-4 h-4 text-[var(--brand-primary)]" />
                      المجموعات المستهدفة
                      {selectedGroups.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">
                          {selectedGroups.length} محددة
                        </span>
                      )}
                    </p>
                    <div className="flex gap-1.5">
                      <button onClick={selectAll}  className="text-xs text-[var(--brand-primary)] hover:underline">تحديد الكل</button>
                      <span className="text-[var(--text-muted)]">·</span>
                      <button onClick={clearAll}   className="text-xs text-[var(--text-muted)] hover:underline">إلغاء</button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 max-h-40 overflow-y-auto border border-[var(--border-default)] rounded-2xl p-2">
                    {publishableGroups.length === 0 ? (
                      <p className="text-sm text-[var(--text-muted)] text-center py-3">لا توجد مجموعات قابلة للنشر</p>
                    ) : (
                      publishableGroups.map(g => (
                        <label key={g.group_jid}
                          className="flex items-center gap-3 p-2 rounded-xl hover:bg-[var(--bg-elevated)] cursor-pointer transition-colors">
                          <input type="checkbox"
                            checked={selectedGroups.includes(g.group_jid)}
                            onChange={() => toggleGroup(g.group_jid)}
                            className="w-4 h-4 accent-[var(--brand-primary)] rounded"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-[var(--text-primary)] truncate">{g.name}</p>
                            <p className="text-xs text-[var(--text-muted)]">{g.members_count.toLocaleString()} عضو</p>
                          </div>
                          <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded',
                            g.publish_status === 'green'
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-yellow-500/10 text-yellow-400'
                          )}>
                            {g.publish_status === 'green' ? '🟢' : '🟡'}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                </div>

                {/* الإعلان / المحتوى */}
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-1.5">
                    <Megaphone className="w-4 h-4 text-[var(--brand-primary)]" />
                    الإعلان أو النص
                  </p>
                  {ads.length > 0 && (
                    <select
                      className="input w-full text-sm"
                      value={adId}
                      onChange={e => { setAdId(e.target.value); if (e.target.value) setCustomContent(''); }}
                    >
                      <option value="">— اختر إعلاناً من المكتبة —</option>
                      {ads.map(ad => (
                        <option key={ad.id} value={ad.id}>{ad.name}</option>
                      ))}
                    </select>
                  )}
                  {!adId && (
                    <textarea
                      className="input w-full min-h-24 resize-none text-sm"
                      placeholder="اكتب نص الرسالة هنا..."
                      value={customContent}
                      onChange={e => setCustomContent(e.target.value)}
                    />
                  )}
                </div>

                {/* الإعدادات المتقدمة */}
                <div className="grid grid-cols-2 gap-3">
                  {/* وقت الإرسال */}
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-semibold text-[var(--text-secondary)] flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />وقت الإرسال
                    </p>
                    <input
                      type="datetime-local"
                      className="input text-sm"
                      value={sendTime}
                      onChange={e => setSendTime(e.target.value)}
                    />
                    <p className="text-[10px] text-[var(--text-muted)]">اتركه فارغاً للإرسال الفوري</p>
                  </div>

                  {/* الفاصل الزمني */}
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-semibold text-[var(--text-secondary)] flex items-center gap-1">
                      <Timer className="w-3.5 h-3.5" />الفاصل بين الرسائل
                    </p>
                    <div className="flex gap-1 flex-wrap">
                      {[2, 3, 5, 10, 15, 30].map(sec => (
                        <button key={sec}
                          onClick={() => setIntervalSec(sec)}
                          className={cn('px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                            intervalSec === sec
                              ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                              : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border-[var(--border-default)]'
                          )}
                        >
                          {sec < 60 ? `${sec}ث` : `${sec/60}د`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* خيارات الاستثناء */}
                <div className="flex flex-col gap-2 p-3 bg-[var(--bg-elevated)] rounded-2xl border border-[var(--border-default)]">
                  <p className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-1.5">
                    <UserMinus className="w-4 h-4 text-orange-400" />
                    خيارات الاستثناء
                  </p>

                  {/* استثناء المشرفين */}
                  <div className="flex items-center justify-between py-2 border-b border-[var(--border-default)]">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">استثناء المشرفين</p>
                      <p className="text-xs text-[var(--text-muted)]">تجاهل مشرفي المجموعة عند الإرسال</p>
                    </div>
                    <button
                      onClick={() => setExcludeAdmins(!excludeAdmins)}
                      className={cn('w-11 h-6 rounded-full transition-all relative shrink-0',
                        excludeAdmins ? 'bg-orange-500' : 'bg-[var(--bg-overlay)]'
                      )}
                    >
                      <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm',
                        excludeAdmins ? 'right-1' : 'left-1'
                      )} />
                    </button>
                  </div>

                  {/* إدارة قائمة الاستثناءات */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">قائمة الاستثناءات المخصصة</p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {exclusionCount > 0 ? `${exclusionCount} رقم مستثنى` : 'لا توجد أرقام مستثناة'}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setShowExManager(true)} className="gap-1.5 text-xs">
                      <Settings className="w-3.5 h-3.5" />إدارة
                    </Button>
                  </div>
                </div>

                {previewError && (
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/5 border border-red-500/20">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                    <p className="text-sm text-red-400">{previewError}</p>
                  </div>
                )}

                <Button
                  onClick={handlePreview}
                  disabled={selectedGroups.length === 0 || previewLoading}
                  className="w-full gap-2"
                >
                  {previewLoading
                    ? <><RefreshCw className="w-4 h-4 animate-spin" />جاري تحميل المعاينة...</>
                    : <><EyeIcon className="w-4 h-4" />معاينة الأعضاء المستهدفين</>
                  }
                </Button>
              </div>
            )}

            {/* ══════ الخطوة 2: المعاينة ══════ */}
            {step === 2 && (
              <div className="flex flex-col gap-4 pt-2">
                {/* ملخص */}
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'إجمالي المستهدفين', value: previewTargets.length.toLocaleString(), color: 'text-[var(--brand-primary)]' },
                    { label: 'وقت الإرسال التقديري', value: estimatedMinutes > 60 ? `${Math.floor(estimatedMinutes/60)}س ${estimatedMinutes%60}د` : `${estimatedMinutes} دقيقة`, color: 'text-blue-400' },
                    { label: 'الفاصل الزمني', value: `${intervalSec} ثانية`, color: 'text-green-400' },
                  ].map((s, i) => (
                    <div key={i} className="bg-[var(--bg-elevated)] rounded-xl p-3 text-center border border-[var(--border-default)]">
                      <p className={cn('text-lg font-bold', s.color)}>{s.value}</p>
                      <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{s.label}</p>
                    </div>
                  ))}
                </div>

                {/* تحذير للأعداد الكبيرة */}
                {previewTargets.length > 100 && (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-yellow-500/5 border border-yellow-500/20">
                    <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-bold text-yellow-400">تنبيه: عدد كبير من المستهدفين</p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        سيستغرق الإرسال حوالي {estimatedMinutes} دقيقة. تأكد أن الحساب سيبقى متصلاً طوال هذه المدة.
                      </p>
                    </div>
                  </div>
                )}

                {/* قائمة المستهدفين */}
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">عينة من المستهدفين</p>
                  <div className="flex flex-col gap-1 max-h-48 overflow-y-auto border border-[var(--border-default)] rounded-2xl p-2">
                    {previewTargets.slice(0, 50).map((t: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--bg-elevated)]">
                        <div className="w-6 h-6 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center shrink-0">
                          <Phone className="w-3 h-3 text-[var(--text-muted)]" />
                        </div>
                        <span className="text-xs font-mono text-[var(--text-primary)]">+{t.phone}</span>
                        {t.is_admin && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]">مشرف</span>
                        )}
                      </div>
                    ))}
                    {previewTargets.length > 50 && (
                      <p className="text-xs text-[var(--text-muted)] text-center py-2">
                        ... و {(previewTargets.length - 50).toLocaleString()} آخرين
                      </p>
                    )}
                  </div>
                </div>

                {/* ملخص المحتوى */}
                {(customContent || adId) && (
                  <div className="p-3 bg-[var(--bg-elevated)] rounded-2xl border border-[var(--border-default)]">
                    <p className="text-xs font-semibold text-[var(--text-secondary)] mb-1">محتوى الرسالة</p>
                    <p className="text-sm text-[var(--text-primary)] line-clamp-3">
                      {customContent || (ads.find(a => a.id === adId)?.name || 'إعلان من المكتبة')}
                    </p>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setStep(1)} className="flex-1 gap-2">
                    <ChevronRight className="w-4 h-4" />العودة للإعداد
                  </Button>
                  <Button
                    onClick={handleSend}
                    disabled={sending || (!customContent && !adId)}
                    className="flex-1 gap-2"
                  >
                    {sending
                      ? <><RefreshCw className="w-4 h-4 animate-spin" />جاري الإرسال...</>
                      : sendTime
                        ? <><Calendar className="w-4 h-4" />جدولة الإرسال</>
                        : <><Send className="w-4 h-4" />إرسال الآن ({previewTargets.length})</>
                    }
                  </Button>
                </div>
              </div>
            )}

            {/* ══════ الخطوة 3: النتيجة ══════ */}
            {step === 3 && result && (
              <div className="flex flex-col gap-4 pt-2">
                <div className={cn(
                  'p-5 rounded-2xl text-center border-2',
                  result.success
                    ? 'bg-green-500/5 border-green-500/20'
                    : 'bg-red-500/5 border-red-500/20'
                )}>
                  <div className={cn(
                    'w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3',
                    result.success ? 'bg-green-500/10' : 'bg-red-500/10'
                  )}>
                    {result.success
                      ? <CheckCircle2 className="w-7 h-7 text-green-400" />
                      : <AlertCircle  className="w-7 h-7 text-red-400" />
                    }
                  </div>
                  <p className={cn('text-lg font-bold', result.success ? 'text-green-400' : 'text-red-400')}>
                    {result.success ? (result.scheduled ? 'تم جدولة الإرسال ✅' : 'تم الإرسال ✅') : 'فشل الإرسال ❌'}
                  </p>
                  <p className="text-sm text-[var(--text-secondary)] mt-2">{result.message || result.error}</p>
                </div>

                {result.success && !result.scheduled && (
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: 'المُرسَل',   value: result.sent   || 0, color: 'text-green-400' },
                      { label: 'الفاشل',    value: result.failed || 0, color: 'text-red-400'   },
                      { label: 'الإجمالي',  value: result.total  || 0, color: 'text-[var(--brand-primary)]' },
                    ].map((s, i) => (
                      <div key={i} className="bg-[var(--bg-elevated)] rounded-xl p-3 text-center">
                        <p className={cn('text-xl font-bold', s.color)}>{s.value}</p>
                        <p className="text-[10px] text-[var(--text-muted)]">{s.label}</p>
                      </div>
                    ))}
                  </div>
                )}

                <Button onClick={onClose} className="w-full">إغلاق</Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* مودال إدارة الاستثناءات */}
      {showExManager && (
        <ExclusionManagerModal
          accountId={accountId}
          onClose={() => setShowExManager(false)}
        />
      )}
    </>
  );
}

/* ─────────────── Group Detail Modal ─────────────── */
function GroupModal({ group, accountId, onClose }: {
  group: WaGroup; accountId: string; onClose: () => void
}) {
  const [tab, setTab] = useState('info');
  const content: Record<string, React.ReactNode> = {
    info:    <TabInfo    group={group} />,
    publish: <TabPublish group={group} />,
    members: <TabMembers group={group} accountId={accountId} />,
    stats:   <TabStats   group={group} />,
    send:    <TabSend    group={group} />,
    auto:    <TabAuto    group={group} />,
  };
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg flex flex-col max-h-[90vh]">
        <DialogHeader className="pb-0">
          <div className="flex items-center gap-3">
            <GroupAvatar group={group} size="lg" />
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base leading-snug truncate">{group.name}</DialogTitle>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {group.members_count.toLocaleString()} عضو • {group.admins_count} مشرف
              </p>
              <div className="mt-1"><PublishBadge status={group.publish_status} /></div>
            </div>
          </div>
        </DialogHeader>
        <div className="flex gap-1 overflow-x-auto py-1 shrink-0" style={{ scrollbarWidth: 'none' }}>
          {GROUP_TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-colors shrink-0',
                tab === t.id
                  ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              )}>
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">{content[tab]}</div>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────── Skeleton Loading ─────────────── */

/* ─────────────── Category View (الجزء الثاني) ─────────────── */
function CategoryRow({ group, onClick }: { group: WaGroup; onClick: () => void }) {
  const statusConfig = {
    green:  { icon: CheckSquare, cls: 'text-green-400',  bg: 'bg-green-500/10'  },
    yellow: { icon: MinusSquare, cls: 'text-yellow-400', bg: 'bg-yellow-500/10' },
    red:    { icon: XSquare,     cls: 'text-red-400',    bg: 'bg-red-500/10'    },
  };
  const cfg = statusConfig[group.publish_status as keyof typeof statusConfig] || statusConfig.red;
  const StatusIcon = cfg.icon;

  return (
    <div
      onClick={onClick}
      className="flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--bg-elevated)] transition-colors cursor-pointer border border-transparent hover:border-[var(--border-default)]"
    >
      <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', cfg.bg)}>
        <StatusIcon className={cn('w-5 h-5', cfg.cls)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-[var(--text-primary)] truncate">{group.name}</p>
          {group.is_admin && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] shrink-0">
              👑
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
            <Users className="w-3 h-3" />{group.members_count.toLocaleString()}
          </span>
          {group.announce && (
            <span className="text-xs text-yellow-400">📢 إعلانات</span>
          )}
          {!group.is_member && (
            <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
              <Archive className="w-3 h-3" /> مؤرشفة
            </span>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs text-[var(--text-muted)]">{group.activity_level}% نشاط</p>
        <ActivityBar level={group.activity_level} />
      </div>
    </div>
  );
}

function CategoriesPanel({
  accountId,
  onGroupClick,
}: {
  accountId: string;
  onGroupClick: (g: WaGroup) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error,   setError  ] = useState<string|null>(null);
  const [cats,    setCats   ] = useState<GroupCategories | null>(null);
  const [stats,   setStats  ] = useState<CategoryStats | null>(null);
  const [activeTab, setActiveTab] = useState<'publishable'|'restricted'|'nonPublishable'|'archived'>('publishable');
  const [search, setSearch] = useState('');

  const fetchCategories = useCallback(async (refresh = false) => {
    if (!accountId) return;
    if (refresh) setSyncing(true); else setLoading(true);
    setError(null);
    try {
      const url = `${API}/accounts/${accountId}/groups/categories${refresh ? '?refresh=1' : ''}`;
      const res  = await authFetch(url);
      const data = await res.json();
      if (data.success) {
        setCats(data.categories);
        setStats(data.stats);
      } else {
        setError(data.error || 'فشل جلب التصنيفات');
      }
    } catch {
      setError('خطأ في الاتصال بالخادم');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, [accountId]);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  const TABS = [
    { id: 'publishable'    as const, label: 'قابلة للنشر',     icon: CheckSquare, color: 'text-green-400',  count: cats?.publishable.count    || 0 },
    { id: 'restricted'     as const, label: 'مقيدة',            icon: MinusSquare, color: 'text-yellow-400', count: cats?.restricted.count     || 0 },
    { id: 'nonPublishable' as const, label: 'غير قابلة',        icon: XSquare,     color: 'text-red-400',    count: cats?.nonPublishable.count || 0 },
    { id: 'archived'       as const, label: 'مؤرشفة',           icon: Archive,     color: 'text-gray-400',   count: cats?.archived.count       || 0 },
  ];

  const currentGroups = useMemo(() => {
    if (!cats) return [];
    const g = cats[activeTab]?.groups || [];
    if (!search) return g;
    return g.filter(x => x.name.includes(search) || x.group_jid.includes(search));
  }, [cats, activeTab, search]);

  if (loading) return (
    <div className="flex flex-col gap-2">
      {[...Array(5)].map((_, i) => <div key={i} className="h-16 bg-[var(--bg-elevated)] rounded-xl animate-pulse" />)}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* إحصائيات التصنيفات */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'قابلة للنشر',  value: stats.publishable,    color: 'text-green-400',  bg: 'bg-green-500/10'  },
            { label: 'مقيدة',         value: stats.restricted,     color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
            { label: 'غير قابلة',     value: stats.nonPublishable, color: 'text-red-400',    bg: 'bg-red-500/10'    },
            { label: 'مؤرشفة',        value: stats.archived,       color: 'text-gray-400',   bg: 'bg-gray-500/10'   },
          ].map((s, i) => (
            <div key={i} className={cn('rounded-xl p-3 text-center border border-[var(--border-default)]', s.bg)}>
              <p className={cn('text-xl font-bold', s.color)}>{s.value}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* أزرار عملية */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={() => fetchCategories(true)} disabled={syncing} className="gap-1.5">
          <RefreshCw className={cn('w-3.5 h-3.5', syncing && 'animate-spin')} />
          {syncing ? 'جاري المزامنة...' : 'مزامنة وتحديث'}
        </Button>
        <span className="text-xs text-[var(--text-muted)]">
          {stats ? `${stats.total} مجموعة إجمالاً · ${stats.totalMembers.toLocaleString()} عضو` : ''}
        </span>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/5 border border-red-500/20">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* تبويبات التصنيف */}
      <div className="flex gap-1 flex-wrap">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors',
              activeTab === t.id
                ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-[var(--border-default)]'
            )}
          >
            <t.icon className={cn('w-3.5 h-3.5', activeTab === t.id ? 'text-white' : t.color)} />
            {t.label}
            <span className={cn(
              'px-1.5 py-0.5 rounded text-[9px] font-bold',
              activeTab === t.id ? 'bg-white/20' : 'bg-[var(--bg-overlay)]'
            )}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* بحث */}
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
        <input
          className="input pr-9 w-full"
          placeholder="بحث..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* قائمة المجموعات */}
      <div className="flex flex-col divide-y divide-[var(--border-default)] bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] overflow-hidden">
        {currentGroups.length === 0 ? (
          <div className="p-8 text-center">
            <Users className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3" />
            <p className="text-sm text-[var(--text-muted)]">لا توجد مجموعات في هذه الفئة</p>
          </div>
        ) : (
          currentGroups.map(g => (
            <div key={g.group_jid} className="px-2">
              <CategoryRow group={g} onClick={() => onGroupClick(g)} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}


/* ─────────────── Skeleton Loading ─────────────── */
function GroupSkeleton() {
  return (
    <div className="card p-4 animate-pulse">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-12 h-12 rounded-2xl bg-[var(--bg-elevated)]" />
        <div className="flex-1">
          <div className="h-4 bg-[var(--bg-elevated)] rounded w-3/4 mb-2" />
          <div className="h-3 bg-[var(--bg-elevated)] rounded w-1/2" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[0,1,2].map(i => <div key={i} className="h-14 bg-[var(--bg-elevated)] rounded-xl" />)}
      </div>
      <div className="h-1.5 bg-[var(--bg-elevated)] rounded-full" />
    </div>
  );
}

/* ─────────────── Progress Indicator ─────────────── */
function AutoSyncIndicator({
  enabled,
  intervalMinutes,
  syncedAt,
  nextSyncIn,
}: {
  enabled: boolean;
  intervalMinutes: number;
  syncedAt: string | null;
  nextSyncIn: number; // seconds
}) {
  if (!enabled || intervalMinutes === 0) return null;

  const totalSeconds = intervalMinutes * 60;
  const pct = totalSeconds > 0 ? Math.max(0, Math.min(100, ((totalSeconds - nextSyncIn) / totalSeconds) * 100)) : 0;

  const fmt = (s: number) => {
    if (s <= 0) return 'الآن';
    if (s < 60) return `${s}ث`;
    if (s < 3600) return `${Math.floor(s / 60)}د`;
    return `${Math.floor(s / 3600)}س`;
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
      <div className="relative w-6 h-6 shrink-0">
        <svg className="w-6 h-6 -rotate-90" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" fill="none" stroke="var(--border-default)" strokeWidth="2.5" />
          <circle cx="12" cy="12" r="9" fill="none" stroke="var(--brand-primary)" strokeWidth="2.5"
            strokeDasharray={`${2 * Math.PI * 9}`}
            strokeDashoffset={`${2 * Math.PI * 9 * (1 - pct / 100)}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 1s linear' }}
          />
        </svg>
        <RefreshCw className="w-2.5 h-2.5 text-[var(--brand-primary)] absolute inset-0 m-auto" />
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-[10px] text-[var(--text-muted)]">تحديث تلقائي</span>
        <span className="text-xs font-bold text-[var(--brand-primary)]">
          {nextSyncIn <= 0 ? 'جاري التحديث...' : `بعد ${fmt(nextSyncIn)}`}
        </span>
      </div>
    </div>
  );
}

/* ─────────────── Main View ─────────────── */
export default function GroupsView({ accountId }: { accountId: string | null }) {
  // ★ تهيئة الحالة من الكاش العالمي مباشرة — لا يختفي البيانات عند العودة
  const cached = accountId ? globalCache.get(accountId) : null;

  const [groups,        setGroups       ] = useState<WaGroup[]>(cached?.groups || []);
  const [loading,       setLoading      ] = useState(false);
  const [syncing,       setSyncing      ] = useState(false);
  const [error,         setError        ] = useState<string | null>(null);
  const [syncedAt,      setSyncedAt     ] = useState<string | null>(cached?.syncedAt || null);
  const [filter,        setFilter       ] = useState('all');
  const [search,        setSearch       ] = useState('');
  const [showFilters,   setShowFilters  ] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<WaGroup | null>(null);
  const [showSyncSettings, setShowSyncSettings] = useState(false);
  const [nextSyncIn,    setNextSyncIn   ] = useState(0);
  const [viewMode,      setViewMode     ] = useState<'grid'|'categories'>('grid');
  // الجزء الخامس
  const [showMemberPublish, setShowMemberPublish] = useState(false);

  // إعدادات المزامنة — مخزّنة في localStorage
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(() => {
    if (!accountId) return { interval_minutes: 15, auto_sync_enabled: true, last_auto_sync: null };
    try {
      const stored = localStorage.getItem(`wa_sync_${accountId}`);
      return stored ? JSON.parse(stored) : { interval_minutes: 15, auto_sync_enabled: true, last_auto_sync: null };
    } catch { return { interval_minutes: 15, auto_sync_enabled: true, last_auto_sync: null }; }
  });

  const autoRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimer   = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextSyncRef      = useRef<number>(syncSettings.interval_minutes * 60);

  // ── حفظ إعدادات المزامنة ───────────────────────────────────────────────
  const saveSyncSettings = useCallback((s: SyncSettings) => {
    if (!accountId) return;
    setSyncSettings(s);
    try { localStorage.setItem(`wa_sync_${accountId}`, JSON.stringify(s)); } catch {}
  }, [accountId]);

  // ── جلب المجموعات من الكاش أولاً ثم تحديث الـ state ───────────────────
  const fetchGroups = useCallback(async (forceRefresh = false) => {
    if (!accountId) return;

    // إذا لدينا كاش حديث (< 60 ثانية) وليس force refresh — لا داعي للجلب
    const existing = globalCache.get(accountId);
    if (!forceRefresh && existing && (Date.now() - existing.ts) < 60_000) return;

    // إذا كان هناك كاش قديم، أبقِ عليه أثناء التحميل (لا تعرض حالة فارغة)
    if (!existing) setLoading(true);
    setError(null);

    try {
      const url = `${API}/accounts/${accountId}/groups${forceRefresh ? '?refresh=1' : ''}`;
      const res  = await authFetch(url);
      const ct   = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        setError('خطأ في الاتصال بالخادم — تأكد من تشغيل الـ backend');
        return;
      }
      const data = await res.json();
      if (data.success) {
        const safeGroups = (data.groups || []).map((g: any) => ({
          id:              String(g.id              ?? g.group_jid ?? ''),
          group_jid:       String(g.group_jid       ?? ''),
          name:            String(g.name            ?? 'مجموعة'),
          description:     String(g.description     ?? ''),
          owner:           String(g.owner           ?? ''),
          members_count:   Number(g.members_count)  || 0,
          admins_count:    Number(g.admins_count)   || 0,
          announce:        Boolean(g.announce),
          restrict:        Boolean(g.restrict),
          creation_ts:     Number(g.creation_ts)    || 0,
          avatar_url:      g.avatar_url ? String(g.avatar_url) : null,
          is_member:       Boolean(g.is_member),
          is_admin:        Boolean(g.is_admin),
          publish_status:  (['green','yellow','red'].includes(g.publish_status) ? g.publish_status : 'red') as WaGroup['publish_status'],
          can_send_text:   Boolean(g.can_send_text),
          can_send_images: Boolean(g.can_send_images),
          can_send_video:  Boolean(g.can_send_video),
          can_send_files:  Boolean(g.can_send_files),
          can_send_links:  Boolean(g.can_send_links),
          can_broadcast:   Boolean(g.can_broadcast),
          activity_level:  Math.min(100, Math.max(0, Number(g.activity_level) || 50)),
          messages_today:  Number(g.messages_today) || 0,
          last_sync:       g.last_sync ? String(g.last_sync) : null,
        }));

        setGroups(safeGroups);
        const newSyncedAt = data.synced_at ? String(data.synced_at) : null;
        setSyncedAt(newSyncedAt);

        // ★ تحديث الكاش العالمي
        globalCache.set(accountId, { groups: safeGroups, syncedAt: newSyncedAt, ts: Date.now() });

        // تحديث إعدادات المزامنة من الخادم إن وُجدت
        if (data.sync_settings) {
          const ss: SyncSettings = {
            interval_minutes:  data.sync_settings.interval_minutes ?? 15,
            auto_sync_enabled: data.sync_settings.auto_sync_enabled ?? true,
            last_auto_sync:    data.sync_settings.last_auto_sync ?? null,
          };
          saveSyncSettings(ss);
        }

        if (data.warning) setError(String(data.warning));
      } else {
        setError(String(data.error || 'فشل جلب المجموعات'));
      }
    } catch (e: any) {
      setError(String(e?.message || 'خطأ في الاتصال'));
    } finally {
      setLoading(false);
    }
  }, [accountId, saveSyncSettings]);

  // ── مزامنة يدوية فورية ─────────────────────────────────────────────────
  const handleSync = async () => {
    if (!accountId || syncing) return;
    setSyncing(true);
    setError(null);
    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/groups/sync`, { method: 'POST' });
      const ct   = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { setError('خطأ في الاتصال'); return; }
      const data = await res.json();
      if (data.success) {
        const safeGroups = (data.groups || []).map((g: any) => ({
          id:              String(g.id              ?? g.group_jid ?? ''),
          group_jid:       String(g.group_jid       ?? ''),
          name:            String(g.name            ?? 'مجموعة'),
          description:     String(g.description     ?? ''),
          owner:           String(g.owner           ?? ''),
          members_count:   Number(g.members_count)  || 0,
          admins_count:    Number(g.admins_count)   || 0,
          announce:        Boolean(g.announce),
          restrict:        Boolean(g.restrict),
          creation_ts:     Number(g.creation_ts)    || 0,
          avatar_url:      g.avatar_url ? String(g.avatar_url) : null,
          is_member:       Boolean(g.is_member),
          is_admin:        Boolean(g.is_admin),
          publish_status:  (['green','yellow','red'].includes(g.publish_status) ? g.publish_status : 'red') as WaGroup['publish_status'],
          can_send_text:   Boolean(g.can_send_text),
          can_send_images: Boolean(g.can_send_images),
          can_send_video:  Boolean(g.can_send_video),
          can_send_files:  Boolean(g.can_send_files),
          can_send_links:  Boolean(g.can_send_links),
          can_broadcast:   Boolean(g.can_broadcast),
          activity_level:  Math.min(100, Math.max(0, Number(g.activity_level) || 50)),
          messages_today:  Number(g.messages_today) || 0,
          last_sync:       g.last_sync ? String(g.last_sync) : null,
        }));
        const newSyncedAt = data.synced_at ? String(data.synced_at) : new Date().toISOString();
        setGroups(safeGroups);
        setSyncedAt(newSyncedAt);
        globalCache.set(accountId, { groups: safeGroups, syncedAt: newSyncedAt, ts: Date.now() });
        // إعادة ضبط العداد التنازلي
        nextSyncRef.current = syncSettings.interval_minutes * 60;
        setNextSyncIn(nextSyncRef.current);
      } else {
        setError(String(data.error || 'فشلت المزامنة'));
      }
    } catch (e: any) {
      setError(String(e?.message || 'خطأ في الاتصال'));
    } finally {
      setSyncing(false);
    }
  };

  // ── تحميل عند تغيير الحساب ─────────────────────────────────────────────
  useEffect(() => {
    if (!accountId) return;
    const existing = globalCache.get(accountId);
    if (existing) {
      // عرض الكاش فوراً
      setGroups(existing.groups);
      setSyncedAt(existing.syncedAt);
    }
    // جلب التحديثات من الخادم في الخلفية (بدون إخفاء البيانات)
    fetchGroups(false);
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── العداد التنازلي ─────────────────────────────────────────────────────
  useEffect(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    if (!syncSettings.auto_sync_enabled || syncSettings.interval_minutes === 0) {
      setNextSyncIn(0);
      return;
    }
    nextSyncRef.current = syncSettings.interval_minutes * 60;
    setNextSyncIn(nextSyncRef.current);

    countdownTimer.current = setInterval(() => {
      nextSyncRef.current = Math.max(0, nextSyncRef.current - 1);
      setNextSyncIn(nextSyncRef.current);
    }, 1000);

    return () => {
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, [syncSettings.interval_minutes, syncSettings.auto_sync_enabled]);

  // ── التحديث التلقائي الدوري ─────────────────────────────────────────────
  useEffect(() => {
    if (autoRefreshTimer.current) clearInterval(autoRefreshTimer.current);
    if (!accountId || !syncSettings.auto_sync_enabled || syncSettings.interval_minutes === 0) return;

    const intervalMs = syncSettings.interval_minutes * 60 * 1000;
    autoRefreshTimer.current = setInterval(async () => {
      console.log(`[GroupsView] Auto-fetching groups for ${accountId}...`);
      await fetchGroups(false);
      nextSyncRef.current = syncSettings.interval_minutes * 60;
      setNextSyncIn(nextSyncRef.current);
    }, intervalMs);

    return () => {
      if (autoRefreshTimer.current) clearInterval(autoRefreshTimer.current);
    };
  }, [accountId, syncSettings.interval_minutes, syncSettings.auto_sync_enabled, fetchGroups]);

  // ── فلترة المجموعات ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!accountId) return [];
    return groups.filter(g => {
      if (filter === 'green'    && g.publish_status !== 'green')  return false;
      if (filter === 'yellow'   && g.publish_status !== 'yellow') return false;
      if (filter === 'red'      && g.publish_status !== 'red')    return false;
      if (filter === 'admin'    && !g.is_admin)                   return false;
      if (filter === 'large'    && g.members_count < 200)         return false;
      if (filter === 'announce' && !g.announce)                   return false;
      if (search && !g.name.includes(search) && !g.group_jid.includes(search)) return false;
      return true;
    });
  }, [accountId, groups, filter, search]);

  // ── إحصائيات ────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!accountId) return { total: 0, canPublish: 0, asAdmin: 0, totalMem: 0, restricted: 0, avgAct: 0 };
    const total      = groups.length;
    const canPublish = groups.filter(g => g.publish_status !== 'red').length;
    const asAdmin    = groups.filter(g => g.is_admin).length;
    const totalMem   = groups.reduce((s, g) => s + g.members_count, 0);
    const restricted = groups.filter(g => g.publish_status === 'yellow').length;
    const avgAct     = total ? Math.round(groups.reduce((s, g) => s + g.activity_level, 0) / total) : 0;
    return { total, canPublish, asAdmin, totalMem, restricted, avgAct };
  }, [accountId, groups]);

  // ── حالة: لا يوجد حساب مختار ────────────────────────────────────────────
  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">
            يجب اختيار حساب واتساب نشط لعرض المجموعات الحقيقية.
          </p>
        </div>
      </div>
    );
  }

  const activeInterval = SYNC_OPTIONS.find(o => o.value === syncSettings.interval_minutes);

  return (
    <div className="flex flex-col gap-5 h-full">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">مجموعاتي على واتساب</h1>
          <p className="text-[var(--text-secondary)] mt-1 text-sm">
            بيانات حقيقية مستخرجة مباشرة من الحساب المتصل
            {syncedAt && (
              <span className="text-[var(--text-muted)] mr-1">
                · آخر مزامنة: {timeAgo(syncedAt)}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">

          {/* مؤشر التحديث التلقائي */}
          <AutoSyncIndicator
            enabled={syncSettings.auto_sync_enabled}
            intervalMinutes={syncSettings.interval_minutes}
            syncedAt={syncedAt}
            nextSyncIn={nextSyncIn}
          />

          {/* زر المزامنة اليدوية */}
          <Button onClick={handleSync} disabled={syncing} className="gap-2 shrink-0" size="sm">
            <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
            {syncing ? 'جارٍ المزامنة...' : '🔄 مزامنة'}
          </Button>

          {/* ★ زر النشر إلى أعضاء المجموعات — الجزء الخامس */}
          <Button
            onClick={() => setShowMemberPublish(true)}
            disabled={groups.length === 0}
            size="sm"
            className="gap-2 shrink-0 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white border-0 shadow-lg shadow-violet-500/20"
          >
            <SendHorizonal className="w-4 h-4" />
            النشر إلى أعضاء المجموعات
          </Button>

          {/* إعدادات المزامنة التلقائية */}
          <div className="relative">
            <Button
              variant="outline" size="sm"
              className={cn('gap-2 shrink-0', syncSettings.auto_sync_enabled && syncSettings.interval_minutes > 0 && 'border-[var(--brand-primary)]/40')}
              onClick={() => setShowSyncSettings(!showSyncSettings)}
            >
              <Timer className="w-4 h-4" />
              {activeInterval?.short || 'يدوي'}
              <ChevronDown className={cn('w-3 h-3 transition-transform', showSyncSettings && 'rotate-180')} />
            </Button>

            {showSyncSettings && (
              <SyncSettingsPanel
                accountId={accountId}
                settings={syncSettings}
                onSave={(s) => {
                  saveSyncSettings(s);
                  nextSyncRef.current = s.interval_minutes * 60;
                  setNextSyncIn(nextSyncRef.current);
                }}
                onClose={() => setShowSyncSettings(false)}
              />
            )}
          </div>

          {/* تبديل العرض */}
          <div className="flex gap-1 bg-[var(--bg-elevated)] rounded-xl p-1 border border-[var(--border-default)]">
            <button
              onClick={() => setViewMode('grid')}
              className={cn('p-1.5 rounded-lg transition-colors', viewMode === 'grid' ? 'bg-[var(--brand-primary)] text-white' : 'text-[var(--text-muted)]')}
              title="عرض شبكي"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('categories')}
              className={cn('p-1.5 rounded-lg transition-colors', viewMode === 'categories' ? 'bg-[var(--brand-primary)] text-white' : 'text-[var(--text-muted)]')}
              title="عرض التصنيفات"
            >
              <Filter className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* الفلاتر — فقط في العرض الشبكي */}
          {viewMode === 'grid' && (
            <Button variant="outline" size="sm" className="gap-2 shrink-0"
              onClick={() => setShowFilters(!showFilters)}>
              <Filter className="w-4 h-4" />فلترة
              {showFilters ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </Button>
          )}
        </div>
      </div>

      {/* ── شريط حالة المزامنة التلقائية ── */}
      {syncSettings.auto_sync_enabled && syncSettings.interval_minutes > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--brand-primary)]/5 border border-[var(--brand-primary)]/20">
          <div className="w-2 h-2 rounded-full bg-[var(--brand-primary)] animate-pulse" />
          <p className="text-xs text-[var(--brand-primary)]">
            التحديث التلقائي مفعّل · {activeInterval?.label}
          </p>
          <button
            onClick={() => saveSyncSettings({ ...syncSettings, auto_sync_enabled: false })}
            className="mr-auto text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] underline"
          >
            إيقاف
          </button>
        </div>
      )}

      {/* ── تحذير / خطأ ── */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-yellow-500/5 border border-yellow-500/20">
          <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
          <p className="text-sm text-yellow-400">{error}</p>
        </div>
      )}

      {/* ── Stats ── */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        <StatCard icon={Users}        label="إجمالي المجموعات"    value={stats.total}                    color="text-[var(--brand-primary)]" />
        <StatCard icon={UserCheck}    label="إجمالي الأعضاء"      value={stats.totalMem.toLocaleString()} color="text-blue-400" />
        <StatCard icon={CheckCircle2} label="يستطيع النشر"        value={stats.canPublish}                color="text-green-400" />
        <StatCard icon={Crown}        label="أنت مشرف"            value={stats.asAdmin}                   color="text-yellow-400" />
        <StatCard icon={Lock}         label="مقيدة جزئياً"        value={stats.restricted}                color="text-orange-400" />
        <StatCard icon={Zap}          label="معدل النشاط"         value={`${stats.avgAct}%`}              color="text-purple-400" />
      </div>

      {/* ── عرض التصنيفات ── */}
      {viewMode === 'categories' ? (
        <div className="flex-1 overflow-y-auto">
          <CategoriesPanel accountId={accountId} onGroupClick={setSelectedGroup} />
        </div>
      ) : (
        <>
          {/* ── Search + Filters ── */}
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input
                className="input pr-10 w-full"
                placeholder="بحث باسم المجموعة أو المعرّف..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute left-3 top-1/2 -translate-y-1/2">
                  <X className="w-4 h-4 text-[var(--text-muted)] hover:text-[var(--text-primary)]" />
                </button>
              )}
            </div>
            {showFilters && (
              <div className="flex gap-2 flex-wrap">
                {FILTERS.map(f => (
                  <button key={f.id} onClick={() => setFilter(f.id)}
                    className={cn(
                      'px-3 py-1.5 rounded-xl text-xs font-medium transition-colors',
                      filter === f.id
                        ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                        : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-default)]'
                    )}>
                    {f.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Groups Grid ── */}
          <div className="flex-1 overflow-y-auto">
            {loading && groups.length === 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {[...Array(6)].map((_, i) => <GroupSkeleton key={i} />)}
              </div>
            ) : groups.length === 0 && !error ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
                  <WifiOff className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
                  <h3 className="text-lg font-bold text-[var(--text-primary)]">لا توج
