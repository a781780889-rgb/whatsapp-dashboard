import React, { useState, useMemo, useEffect, useCallback } from 'react';
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
  Video, Paperclip, Megaphone, Lock, Unlock
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { API, authFetch } from '@/utils/api';

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

/* ─────────────── Helpers ─────────────── */
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
  { id: 'info',    icon: BarChart3,    label: 'معلومات' },
  { id: 'publish', icon: Send,         label: 'صلاحيات' },
  { id: 'members', icon: Users,        label: 'الأعضاء' },
  { id: 'stats',   icon: TrendingUp,   label: 'إحصائيات' },
  { id: 'send',    icon: Megaphone,    label: 'إرسال' },
  { id: 'auto',    icon: Bot,          label: 'أتمتة' },
];

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('ar-SA');
}

function formatJid(jid: string): string {
  return jid ? jid.replace('@g.us', '').replace('@s.whatsapp.net', '') : '—';
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
    green:  { emoji: '🟢', label: 'يستطيع النشر',       cls: 'bg-green-500/10 text-green-500 border-green-500/20'  },
    yellow: { emoji: '🟡', label: 'مقيد جزئياً',          cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
    red:    { emoji: '🔴', label: 'لا يستطيع النشر',      cls: 'bg-red-500/10 text-red-400 border-red-500/20'        },
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

/* ─────────────── Modal Tabs ─────────────── */
function TabInfo({ group }: { group: WaGroup }) {
  const rows = [
    { label: 'اسم المجموعة',    value: group.name,                  mono: false },
    { label: 'معرّف المجموعة',  value: formatJid(group.group_jid),  mono: true  },
    { label: 'الوصف',           value: group.description || '—',    mono: false },
    { label: 'تاريخ الإنشاء',   value: formatDate(group.creation_ts), mono: false },
    { label: 'المالك',          value: formatJid(group.owner),      mono: true  },
    { label: 'عدد الأعضاء',     value: group.members_count.toLocaleString(), mono: false },
    { label: 'عدد المشرفين',    value: group.admins_count,          mono: false },
    { label: 'نوع المجموعة',    value: group.announce ? 'قناة إعلانات (مشرفون فقط)' : 'مجموعة عامة', mono: false },
    { label: 'دورك',            value: group.is_admin ? 'مشرف' : 'عضو', mono: false },
    { label: 'آخر مزامنة',      value: group.last_sync ? new Date(group.last_sync).toLocaleString('ar-SA') : '—', mono: false },
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
      {/* حالة النشر الإجمالية */}
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
              {group.publish_status === 'green'  ? 'يستطيع النشر بحرية'       :
               group.publish_status === 'yellow' ? 'مقيد — أنت مشرف فقط'      :
                                                    'لا يستطيع النشر'}
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {group.announce
                ? (group.is_admin ? 'مجموعة إعلانات — يمكنك النشر كمشرف' : 'مجموعة إعلانات — فقط المشرفون يرسلون')
                : 'مجموعة عامة — الجميع يستطيع الإرسال'}
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap mt-1">
          {group.is_admin && (
            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] border border-[var(--brand-primary)]/20">
              👑 مشرف
            </span>
          )}
          {group.announce && (
            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
              📢 قناة إعلانات
            </span>
          )}
          {group.restrict && (
            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-orange-500/10 text-orange-400 border border-orange-500/20">
              🔒 إعدادات مقيدة
            </span>
          )}
        </div>
      </div>

      {/* تفاصيل صلاحيات النشر */}
      <div>
        <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2 uppercase tracking-wider">أنواع المحتوى</p>
        <div className="bg-[var(--bg-elevated)] rounded-2xl px-4">
          <CapabilityRow icon={MessageSquare} label="نشر نصوص"           allowed={group.can_send_text}   />
          <CapabilityRow icon={Image}         label="نشر صور"             allowed={group.can_send_images} />
          <CapabilityRow icon={Video}         label="نشر فيديو"           allowed={group.can_send_video}  />
          <CapabilityRow icon={Paperclip}     label="نشر ملفات"           allowed={group.can_send_files}  />
          <CapabilityRow icon={Link2}         label="نشر روابط"           allowed={group.can_send_links}  />
          <CapabilityRow icon={Megaphone}     label="رسائل جماعية (بث)"  allowed={group.can_broadcast}   color="text-purple-400" />
        </div>
      </div>

      {/* نصيحة */}
      {!group.can_send_text && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/5 border border-red-500/15">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-400">
            هذه المجموعة في وضع الإعلانات وأنت لست مشرفاً. لا يمكن النشر فيها.
            تواصل مع مشرف المجموعة للحصول على صلاحيات.
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    authFetch(`${API}/accounts/${accountId}/groups/${encodeURIComponent(group.group_jid)}/members`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.success) {
          // بناء قائمة الأعضاء من target_jids + admins
          const all: WaMember[] = [
            ...(d.admins || []).map((id: string) => ({ id, admin: 'admin' })),
            ...(d.target_jids || []).map((id: string) => ({ id, admin: null })),
          ];
          setMembers(all);
        } else {
          setError(d.error || 'فشل جلب الأعضاء');
        }
      })
      .catch(() => { if (!cancelled) setError('خطأ في الاتصال بالخادم'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [group.group_jid, accountId]);

  const shown = useMemo(() => members.filter(m => {
    if (filter === 'admin'  && !m.admin) return false;
    if (filter === 'member' && m.admin)  return false;
    if (search && !m.id.includes(search)) return false;
    return true;
  }), [members, filter, search]);

  if (loading) return (
    <div className="flex flex-col gap-2">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-12 bg-[var(--bg-elevated)] rounded-xl animate-pulse" />
      ))}
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
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
        <input className="input pr-9 w-full" placeholder="بحث برقم الهاتف..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>
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
      <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
        {shown.length === 0
          ? <p className="text-sm text-[var(--text-muted)] text-center py-4">لا توجد نتائج</p>
          : shown.map((m, i) => {
              const phone = m.id.split('@')[0].replace(/:/g, '');
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
                  <button onClick={() => navigator.clipboard?.writeText('+' + phone)}
                    className="p-1 rounded hover:bg-[var(--bg-overlay)]">
                    <Copy className="w-3 h-3 text-[var(--text-muted)]" />
                  </button>
                </div>
              );
            })}
      </div>
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
        <p className="text-xs text-[var(--text-muted)] mt-1">
          {adminCount} مشرف من أصل {memberCount} عضو
        </p>
      </div>

      <div>
        <p className="text-xs font-medium text-[var(--text-secondary)] mb-2">معلومات إضافية</p>
        <div className="flex flex-col gap-1 bg-[var(--bg-elevated)] rounded-2xl px-4 py-2">
          {[
            { label: 'نوع المجموعة', value: group.announce ? 'قناة إعلانات' : 'مجموعة عامة' },
            { label: 'الإعدادات',    value: group.restrict  ? 'مقيدة'        : 'مفتوحة'     },
            { label: 'دورك',         value: group.is_admin  ? '👑 مشرف'       : '👤 عضو'     },
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
    { id: 'text',     icon: MessageSquare, label: 'نص',     allowed: group.can_send_text   },
    { id: 'image',    icon: Image,         label: 'صورة',   allowed: group.can_send_images },
    { id: 'video',    icon: Video,         label: 'فيديو',  allowed: group.can_send_video  },
    { id: 'file',     icon: FileText,      label: 'ملف',    allowed: group.can_send_files  },
    { id: 'schedule', icon: Calendar,      label: 'مجدول',  allowed: canSend              },
  ];

  if (!canSend) return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center">
        <Lock className="w-7 h-7 text-red-400" />
      </div>
      <p className="font-bold text-[var(--text-primary)]">لا يمكن الإرسال</p>
      <p className="text-sm text-[var(--text-muted)] max-w-[220px]">
        هذه مجموعة إعلانات وأنت لست مشرفاً. لا يمكن إرسال رسائل إليها.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 flex-wrap">
        {types.map(t => (
          <button key={t.id} onClick={() => t.allowed && setMsgType(t.id)} disabled={!t.allowed}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              !t.allowed    ? 'opacity-30 cursor-not-allowed bg-[var(--bg-elevated)] text-[var(--text-muted)]' :
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
      {msgType === 'schedule' && (
        <input type="datetime-local" className="input" />
      )}
      <Button className="w-full gap-2"><Send className="w-4 h-4" />إرسال للمجموعة</Button>
    </div>
  );
}

function TabAuto({ group }: { group: WaGroup }) {
  const canAutomate = group.is_admin;
  const automations = [
    { id: 'links',   icon: Link2,         label: 'مراقبة الروابط',    desc: 'رصد وحذف الروابط المحظورة تلقائياً', enabled: false, needsAdmin: true  },
    { id: 'reply',   icon: MessageSquare, label: 'الرد التلقائي',     desc: 'الرد على رسائل بكلمات مفتاحية',      enabled: false, needsAdmin: false },
    { id: 'welcome', icon: Bell,          label: 'الترحيب التلقائي',  desc: 'رسالة ترحيب للأعضاء الجدد',         enabled: false, needsAdmin: true  },
    { id: 'spam',    icon: Shield,        label: 'الحماية من السبام', desc: 'حذف الرسائل المتكررة والمزعجة',      enabled: false, needsAdmin: true  },
    { id: 'filter',  icon: Filter,        label: 'فلترة الكلمات',     desc: 'منع كلمات معينة من المجموعة',        enabled: false, needsAdmin: true  },
  ];
  const [states, setStates] = useState(() =>
    Object.fromEntries(automations.map(a => [a.id, a.enabled]))
  );

  return (
    <div className="flex flex-col gap-2">
      {!canAutomate && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-yellow-500/5 border border-yellow-500/20 mb-1">
          <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
          <p className="text-xs text-yellow-400">بعض الأتمتة تحتاج صلاحية مشرف في المجموعة.</p>
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
              {locked && <p className="text-[10px] text-yellow-400 mt-0.5">⚠️ يحتاج صلاحية مشرف</p>}
            </div>
            <button
              disabled={locked}
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
      <img
        src={group.avatar_url}
        alt={group.name}
        onError={() => setImgError(true)}
        className={cn('rounded-2xl object-cover shrink-0', sizeMap[size])}
      />
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
    <div
      onClick={onClick}
      className="card p-4 cursor-pointer hover:border-[var(--brand-primary)]/40 transition-all hover:-translate-y-0.5 group"
    >
      {/* Header */}
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

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { icon: Users,         value: group.members_count.toLocaleString(), label: 'عضو'      },
          { icon: Crown,         value: group.admins_count,                    label: 'مشرف'     },
          { icon: Activity,      value: `${group.activity_level}%`,           label: 'نشاط'     },
        ].map((s, i) => (
          <div key={i} className="bg-[var(--bg-elevated)] rounded-xl p-2 text-center">
            <s.icon className="w-3.5 h-3.5 text-[var(--brand-primary)] mx-auto mb-1" />
            <p className="text-sm font-bold text-[var(--text-primary)]">{s.value}</p>
            <p className="text-[10px] text-[var(--text-muted)]">{s.label}</p>
          </div>
        ))}
      </div>

      <ActivityBar level={group.activity_level} />

      {/* Footer */}
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
              <div className="mt-1">
                <PublishBadge status={group.publish_status} />
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto py-1 shrink-0" style={{ scrollbarWidth: 'none' }}>
          {GROUP_TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-colors shrink-0',
                tab === t.id
                  ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              )}
            >
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {content[tab]}
        </div>
      </DialogContent>
    </Dialog>
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

/* ─────────────── Main View ─────────────── */
export default function GroupsView({ accountId }: { accountId: string | null }) {
  const [groups,        setGroups       ] = useState<WaGroup[]>([]);
  const [loading,       setLoading      ] = useState(false);
  const [syncing,       setSyncing      ] = useState(false);
  const [error,         setError        ] = useState<string | null>(null);
  const [syncedAt,      setSyncedAt     ] = useState<string | null>(null);
  const [filter,        setFilter       ] = useState('all');
  const [search,        setSearch       ] = useState('');
  const [showFilters,   setShowFilters  ] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<WaGroup | null>(null);

  // ── جلب المجموعات ─────────────────────────────────────────────────────────
  const fetchGroups = useCallback(async (forceRefresh = false) => {
    if (!accountId) return;
    setLoading(true);
    setError(null);

    try {
      const url = `${API}/accounts/${accountId}/groups${forceRefresh ? '?refresh=1' : ''}`;
      const res  = await authFetch(url);

      // تحقق أن الرد JSON وليس HTML أو خطأ شبكة
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        setError('خطأ في الاتصال بالخادم — تأكد من تشغيل الـ backend');
        return;
      }

      const data = await res.json();

      if (data.success) {
        // تأكد أن كل مجموعة تحتوي بيانات آمنة قبل الـ render
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
        setSyncedAt(data.synced_at ? String(data.synced_at) : null);
        if (data.warning) setError(String(data.warning));
      } else {
        setError(String(data.error || 'فشل جلب المجموعات'));
      }
    } catch (e: any) {
      setError(String(e?.message || 'خطأ في الاتصال بالخادم'));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  // ── مزامنة فورية من واتساب ────────────────────────────────────────────────
  const handleSync = async () => {
    if (!accountId || syncing) return;
    setSyncing(true);
    setError(null);

    try {
      const res  = await authFetch(`${API}/accounts/${accountId}/groups/sync`, { method: 'POST' });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        setError('خطأ في الاتصال بالخادم');
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
        setSyncedAt(data.synced_at ? String(data.synced_at) : null);
      } else {
        setError(String(data.error || 'فشلت المزامنة'));
      }
    } catch (e: any) {
      setError(String(e?.message || 'خطأ في الاتصال — تأكد أن الخادم يعمل'));
    } finally {
      setSyncing(false);
    }
  };

  // ── تحميل تلقائي عند اختيار حساب ────────────────────────────────────────
  useEffect(() => {
    if (accountId) {
      setGroups([]);
      setSyncedAt(null);
      setError(null);
      fetchGroups(false);
    }
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── فلترة المجموعات ───────────────────────────────────────────────────────
  // ⚠️ يجب أن تكون useMemo هنا قبل أي return مشروط — قاعدة React Hooks
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

  // ── إحصائيات ─────────────────────────────────────────────────────────────
  // ⚠️ يجب أن تكون useMemo هنا قبل أي return مشروط — قاعدة React Hooks
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

  // ── حالة: لا يوجد حساب مختار ─────────────────────────────────────────────
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
                · آخر مزامنة: {new Date(syncedAt).toLocaleTimeString('ar-SA')}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleSync}
            disabled={syncing}
            className="gap-2 shrink-0"
            size="sm"
          >
            <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
            {syncing ? 'جارٍ المزامنة...' : '🔄 مزامنة'}
          </Button>
          <Button
            variant="outline" size="sm"
            className="gap-2 shrink-0"
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter className="w-4 h-4" />فلترة
            {showFilters ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </Button>
        </div>
      </div>

      {/* ── تحذير / خطأ ── */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-yellow-500/5 border border-yellow-500/20">
          <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
          <p className="text-sm text-yellow-400">{error}</p>
          {error.includes('غير متصل') && (
            <a href="/accounts" className="mr-auto text-xs font-bold text-[var(--brand-primary)] underline">
              ربط الحساب
            </a>
          )}
        </div>
      )}

      {/* ── Stats ── */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        <StatCard icon={Users}       label="إجمالي المجموعات"     value={stats.total}                     color="text-[var(--brand-primary)]" />
        <StatCard icon={UserCheck}   label="إجمالي الأعضاء"       value={stats.totalMem.toLocaleString()}  color="text-blue-400" />
        <StatCard icon={CheckCircle2} label="يستطيع النشر"        value={stats.canPublish}                 color="text-green-400" />
        <StatCard icon={Crown}       label="أنت مشرف"             value={stats.asAdmin}                    color="text-yellow-400" />
        <StatCard icon={Lock}        label="مقيدة جزئياً"         value={stats.restricted}                 color="text-orange-400" />
        <StatCard icon={Zap}         label="معدل النشاط"          value={`${stats.avgAct}%`}               color="text-purple-400" />
      </div>

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
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={cn(
                  'px-3 py-1.5 rounded-xl text-xs font-medium transition-colors',
                  filter === f.id
                    ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                    : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-default)]'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Groups Grid ── */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <GroupSkeleton key={i} />)}
          </div>
        ) : groups.length === 0 && !error ? (
          /* حالة: لا توجد مجموعات مزامنة بعد */
          <div className="h-full flex items-center justify-center">
            <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
              <WifiOff className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
              <h3 className="text-lg font-bold text-[var(--text-primary)]">لا توجد مجموعات محفوظة</h3>
              <p className="text-sm text-[var(--text-secondary)] mt-2 mb-4">
                اضغط «🔄 مزامنة» لجلب مجموعاتك مباشرة من الحساب المتصل.
                <br/>
                <span className="text-[var(--text-muted)] text-xs mt-1 block">
                  تأكد أن الحساب متصل أولاً من صفحة الحسابات.
                </span>
              </p>
              <Button onClick={handleSync} disabled={syncing} className="gap-2">
                <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
                {syncing ? 'جارٍ الجلب من واتساب...' : '🔄 مزامنة الآن'}
              </Button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center p-8">
              <Users className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" />
              <p className="text-[var(--text-secondary)]">لا توجد مجموعات تطابق البحث</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map(g => (
              <GroupCard key={g.group_jid} group={g} onClick={() => setSelectedGroup(g)} />
            ))}
          </div>
        )}
      </div>

      {/* ── Count ── */}
      {groups.length > 0 && (
        <div className="text-xs text-[var(--text-muted)] text-center pb-1">
          عرض {filtered.length} من {groups.length} مجموعة حقيقية
        </div>
      )}

      {/* ── Detail Modal ── */}
      {selectedGroup && (
        <GroupModal
          group={selectedGroup}
          accountId={accountId}
          onClose={() => setSelectedGroup(null)}
        />
      )}
    </div>
  );
}

