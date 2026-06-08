import React, { useState, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import {
  Users, Search, Filter, Download, Send, Bot, Link2,
  BarChart3, Eye, Smartphone, ChevronDown, ChevronUp,
  MessageSquare, Calendar, Crown, Shield, UserCheck,
  Activity, Globe, Hash, Clock, TrendingUp, FileText,
  X, Copy, ExternalLink, Zap, Bell, Star, Phone, Image
} from 'lucide-react';
import { cn } from '@/utils/cn';

/* ─────────────── Mock Data ─────────────── */
const MOCK_GROUPS = [
  { id: 'g1', name: 'مجموعة العملاء المميزين', avatar: null, members: 487, admins: 3, inviteLink: 'https://chat.whatsapp.com/ABC123', joined: '2024-01-15', status: 'active', lastActivity: '2 دقائق', messagesDay: 142, category: 'عملاء', description: 'مجموعة خاصة لأفضل العملاء وأحدث العروض', owner: '+966501234567', createdAt: '2023-06-10', totalMessages: 12400, activityLevel: 88 },
  { id: 'g2', name: 'قناة الإعلانات الرسمية', avatar: null, members: 1230, admins: 5, inviteLink: 'https://chat.whatsapp.com/XYZ789', joined: '2024-02-20', status: 'active', lastActivity: '15 دقيقة', messagesDay: 38, category: 'إعلانات', description: 'القناة الرسمية لإعلانات الشركة والعروض الحصرية', owner: '+966509876543', createdAt: '2022-11-05', totalMessages: 4800, activityLevel: 62 },
  { id: 'g3', name: 'دعم فني - المستوى الأول', avatar: null, members: 265, admins: 8, inviteLink: null, joined: '2024-03-05', status: 'active', lastActivity: '5 دقائق', messagesDay: 217, category: 'دعم', description: 'فريق الدعم الفني للمستوى الأول', owner: '+966507654321', createdAt: '2023-01-20', totalMessages: 31000, activityLevel: 95 },
  { id: 'g4', name: 'مجموعة التسويق الإقليمي', avatar: null, members: 89, admins: 2, inviteLink: 'https://chat.whatsapp.com/MKT456', joined: '2023-11-10', status: 'inactive', lastActivity: '3 أيام', messagesDay: 4, category: 'تسويق', description: 'تنسيق حملات التسويق للمنطقة الشمالية', owner: '+966503344556', createdAt: '2023-09-14', totalMessages: 2100, activityLevel: 18 },
  { id: 'g5', name: 'فريق المبيعات - الرياض', avatar: null, members: 156, admins: 4, inviteLink: 'https://chat.whatsapp.com/SAL321', joined: '2024-01-01', status: 'active', lastActivity: '30 دقيقة', messagesDay: 86, category: 'مبيعات', description: 'فريق مبيعات منطقة الرياض والمنطقة الوسطى', owner: '+966505566778', createdAt: '2023-03-22', totalMessages: 9600, activityLevel: 74 },
  { id: 'g6', name: 'مجموعة الموردين', avatar: null, members: 42, admins: 2, inviteLink: null, joined: '2023-09-15', status: 'inactive', lastActivity: 'أسبوع', messagesDay: 1, category: 'موردون', description: 'التواصل مع الموردين والشركاء', owner: '+966501122334', createdAt: '2023-07-01', totalMessages: 780, activityLevel: 8 },
];

const MOCK_MEMBERS = [
  { id: 1, name: 'أحمد محمد العمري',   phone: '+966501234567', role: 'admin',  joined: '2023-06-10', active: true,  messages: 342 },
  { id: 2, name: 'فاطمة عبدالله',        phone: '+966509876543', role: 'admin',  joined: '2023-08-22', active: true,  messages: 218 },
  { id: 3, name: 'محمد سالم الغامدي',   phone: '+966507654321', role: 'member', joined: '2024-01-05', active: true,  messages: 97  },
  { id: 4, name: 'نورة الحربي',          phone: '+966503344556', role: 'member', joined: '2024-02-14', active: false, messages: 12  },
  { id: 5, name: 'عبدالرحمن القحطاني',  phone: '+966505566778', role: 'member', joined: '2024-03-01', active: true,  messages: 156 },
  { id: 6, name: 'سارة الدوسري',         phone: '+966501122334', role: 'member', joined: '2023-11-20', active: true,  messages: 89  },
];

const MOCK_LINKS = [
  { type: 'whatsapp', url: 'https://chat.whatsapp.com/LINK1', count: 14, lastSeen: '1 ساعة' },
  { type: 'telegram', url: 'https://t.me/channel123', count: 7, lastSeen: '3 ساعات' },
  { type: 'website',  url: 'https://example.com/offers', count: 22, lastSeen: '30 دقيقة' },
  { type: 'telegram', url: 'https://t.me/group456', count: 3, lastSeen: 'أمس' },
  { type: 'website',  url: 'https://shop.example.com', count: 18, lastSeen: '2 ساعة' },
];

/* ─────────────── Helpers ─────────────── */
const FILTERS = [
  { id: 'all',      label: 'جميع المجموعات' },
  { id: 'active',   label: 'النشطة' },
  { id: 'inactive', label: 'غير النشطة' },
  { id: 'large',    label: 'الكبيرة (+200)' },
  { id: 'new',      label: 'الجديدة' },
  { id: 'links',    label: 'تحتوي روابط' },
  { id: 'admin',    label: 'يوجد مشرف' },
];

const LINK_COLORS: Record<string, string> = {
  whatsapp: 'text-green-400 bg-green-400/10',
  telegram: 'text-blue-400 bg-blue-400/10',
  website:  'text-purple-400 bg-purple-400/10',
  channel:  'text-yellow-400 bg-yellow-400/10',
};

const LINK_LABELS: Record<string, string> = {
  whatsapp: 'واتساب', telegram: 'تيليجرام', website: 'موقع', channel: 'قناة',
};

const GROUP_TABS = [
  { id: 'info',    icon: BarChart3,    label: 'معلومات' },
  { id: 'members', icon: Users,        label: 'الأعضاء' },
  { id: 'links',   icon: Link2,        label: 'الروابط' },
  { id: 'export',  icon: Download,     label: 'تصدير' },
  { id: 'stats',   icon: TrendingUp,   label: 'إحصائيات' },
  { id: 'search',  icon: Search,       label: 'بحث' },
  { id: 'send',    icon: Send,         label: 'إرسال' },
  { id: 'auto',    icon: Bot,          label: 'أتمتة' },
];

/* ─────────────── Sub-components ─────────────── */
function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
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
  const color = level >= 80 ? 'bg-green-500' : level >= 50 ? 'bg-yellow-500' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${level}%` }} />
      </div>
      <span className="text-xs text-[var(--text-muted)] w-8">{level}%</span>
    </div>
  );
}

/* ─────────────── Group Modal Tabs ─────────────── */
function TabInfo({ group }: { group: any }) {
  const rows = [
    { label: 'الاسم الكامل', value: group.name },
    { label: 'ID المجموعة', value: group.id, mono: true },
    { label: 'الوصف', value: group.description },
    { label: 'تاريخ الإنشاء', value: group.createdAt },
    { label: 'المالك', value: group.owner, mono: true },
    { label: 'عدد الأعضاء', value: group.members },
    { label: 'عدد المشرفين', value: group.admins },
    { label: 'إجمالي الرسائل', value: group.totalMessages.toLocaleString() },
    { label: 'مستوى النشاط', value: `${group.activityLevel}%` },
  ];
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div key={i} className="flex justify-between items-start py-2.5 border-b border-[var(--border-default)] last:border-0">
          <span className="text-sm text-[var(--text-secondary)] shrink-0">{r.label}</span>
          <span className={cn('text-sm font-medium text-right max-w-[60%] break-all', r.mono ? 'font-mono text-[var(--brand-primary)] text-xs' : 'text-[var(--text-primary)]')}>
            {String(r.value)}
          </span>
        </div>
      ))}
      <div className="mt-2">
        <p className="text-xs text-[var(--text-secondary)] mb-1">مستوى النشاط</p>
        <ActivityBar level={group.activityLevel} />
      </div>
    </div>
  );
}

function TabMembers() {
  const [filter, setFilter] = useState<'all' | 'admin' | 'new' | 'active'>('all');
  const [search, setSearch] = useState('');
  const filters = [
    { id: 'all',    label: 'الجميع' },
    { id: 'admin',  label: 'المشرفون' },
    { id: 'active', label: 'النشطون' },
    { id: 'new',    label: 'الجدد' },
  ];
  const shown = MOCK_MEMBERS.filter(m => {
    if (filter === 'admin'  && m.role !== 'admin') return false;
    if (filter === 'active' && !m.active)          return false;
    if (search && !m.name.includes(search) && !m.phone.includes(search)) return false;
    return true;
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
        <input className="input pr-9 w-full" placeholder="بحث عن عضو..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="flex gap-1 flex-wrap">
        {filters.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id as any)}
            className={cn('px-3 py-1 rounded-lg text-xs font-medium transition-colors', filter === f.id ? 'bg-[var(--brand-primary)] text-white' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
        {shown.map(m => (
          <div key={m.id} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--bg-elevated)] transition-colors">
            <div className={cn('w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0', m.role === 'admin' ? 'bg-[var(--brand-primary)]/20 text-[var(--brand-primary)]' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]')}>
              {m.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium text-[var(--text-primary)] truncate">{m.name}</p>
                {m.role === 'admin' && <Crown className="w-3 h-3 text-[var(--brand-primary)] shrink-0" />}
              </div>
              <p className="text-xs text-[var(--text-muted)] font-mono">{m.phone}</p>
            </div>
            <div className="text-left shrink-0">
              <p className="text-xs font-bold text-[var(--text-primary)]">{m.messages}</p>
              <p className="text-xs text-[var(--text-muted)]">رسالة</p>
            </div>
            <div className={cn('w-2 h-2 rounded-full shrink-0', m.active ? 'bg-green-500' : 'bg-[var(--text-muted)]')} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TabLinks() {
  const types = ['الكل', 'واتساب', 'تيليجرام', 'مواقع'];
  const [active, setActive] = useState('الكل');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1">
        {types.map(t => (
          <button key={t} onClick={() => setActive(t)}
            className={cn('px-3 py-1 rounded-lg text-xs font-medium transition-colors', active === t ? 'bg-[var(--brand-primary)] text-white' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
            {t}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
        {MOCK_LINKS.map((l, i) => (
          <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <span className={cn('px-2 py-0.5 rounded-md text-xs font-bold shrink-0', LINK_COLORS[l.type] || 'text-gray-400 bg-gray-400/10')}>
              {LINK_LABELS[l.type] || l.type}
            </span>
            <p className="text-xs text-[var(--text-secondary)] truncate flex-1">{l.url}</p>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-bold text-[var(--brand-primary)]">{l.count}×</span>
              <button onClick={() => navigator.clipboard?.writeText(l.url)} className="p-1 rounded hover:bg-[var(--bg-overlay)] transition-colors">
                <Copy className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              </button>
              <a href={l.url} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-[var(--bg-overlay)] transition-colors">
                <ExternalLink className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabExport() {
  const formats = [
    { id: 'xlsx', icon: FileText, label: 'Excel', color: 'text-green-400', desc: 'ملف جداول بيانات مع تنسيق كامل' },
    { id: 'csv',  icon: FileText, label: 'CSV',   color: 'text-blue-400',  desc: 'ملف نصي مفصول بفواصل' },
    { id: 'json', icon: Hash,     label: 'JSON',  color: 'text-yellow-400', desc: 'بيانات منظمة للمطورين' },
    { id: 'pdf',  icon: FileText, label: 'PDF',   color: 'text-red-400',   desc: 'تقرير جاهز للطباعة' },
    { id: 'txt',  icon: FileText, label: 'TXT',   color: 'text-gray-400',  desc: 'نص عادي بدون تنسيق' },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--text-secondary)]">اختر صيغة التصدير:</p>
      <div className="grid grid-cols-1 gap-2">
        {formats.map(f => (
          <button key={f.id} className="flex items-center gap-3 p-3 rounded-xl border border-[var(--border-default)] hover:border-[var(--brand-primary)]/50 hover:bg-[var(--bg-elevated)] transition-all text-right">
            <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0 font-bold text-sm', f.color + '/10', f.color)}>
              {f.label}
            </div>
            <div>
              <p className="text-sm font-bold text-[var(--text-primary)]">{f.label}</p>
              <p className="text-xs text-[var(--text-muted)]">{f.desc}</p>
            </div>
            <Download className="w-4 h-4 text-[var(--text-muted)] mr-auto" />
          </button>
        ))}
      </div>
    </div>
  );
}

function TabStats() {
  const weekDays = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const barValues = [42, 78, 95, 63, 110, 134, 87];
  const maxVal = Math.max(...barValues);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'اليوم', value: '142' }, { label: 'الأسبوع', value: '834' }, { label: 'الشهر', value: '3.2K' }
        ].map((s, i) => (
          <div key={i} className="bg-[var(--bg-elevated)] rounded-xl p-3 text-center">
            <p className="text-lg font-bold text-[var(--brand-primary)]">{s.value}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>
      <div>
        <p className="text-xs font-medium text-[var(--text-secondary)] mb-3">الرسائل - آخر 7 أيام</p>
        <div className="flex items-end gap-1.5 h-24">
          {barValues.map((v, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full rounded-t-md bg-[var(--brand-primary)]/80 transition-all" style={{ height: `${(v / maxVal) * 80}px` }} />
              <span className="text-[9px] text-[var(--text-muted)]">{weekDays[i].charAt(0)}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <p className="text-xs font-medium text-[var(--text-secondary)] mb-2">أكثر الأعضاء نشاطاً</p>
        {MOCK_MEMBERS.sort((a,b) => b.messages - a.messages).slice(0,3).map((m, i) => (
          <div key={m.id} className="flex items-center gap-2 py-1.5">
            <span className="text-xs text-[var(--text-muted)] w-4">{i+1}</span>
            <p className="text-sm text-[var(--text-primary)] flex-1 truncate">{m.name}</p>
            <span className="text-xs font-bold text-[var(--brand-primary)]">{m.messages}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabSearch() {
  const [type, setType] = useState('word');
  const [q, setQ] = useState('');
  const types = [
    { id: 'word', label: 'كلمة' }, { id: 'link', label: 'رابط' },
    { id: 'phone', label: 'رقم' }, { id: 'member', label: 'عضو' }, { id: 'date', label: 'تاريخ' },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 flex-wrap">
        {types.map(t => (
          <button key={t.id} onClick={() => setType(t.id)}
            className={cn('px-3 py-1 rounded-lg text-xs font-medium transition-colors', type === t.id ? 'bg-[var(--brand-primary)] text-white' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]')}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
        <input className="input pr-9 w-full"
          placeholder={type === 'date' ? 'YYYY-MM-DD' : `ابحث بـ${types.find(t=>t.id===type)?.label}...`}
          value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <Button className="w-full">بحث داخل المجموعة</Button>
      {q && (
        <div className="bg-[var(--bg-elevated)] rounded-xl p-4 text-center">
          <p className="text-sm text-[var(--text-secondary)]">سيتم عرض نتائج البحث عن <strong className="text-[var(--brand-primary)]">"{q}"</strong> هنا</p>
        </div>
      )}
    </div>
  );
}

function TabSend() {
  const [msgType, setMsgType] = useState('text');
  const types = [
    { id: 'text',     icon: MessageSquare, label: 'نص'    },
    { id: 'image',    icon: Image,         label: 'صورة'  },
    { id: 'file',     icon: FileText,      label: 'ملف'   },
    { id: 'schedule', icon: Calendar,      label: 'مجدول' },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 flex-wrap">
        {types.map(t => (
          <button key={t.id} onClick={() => setMsgType(t.id)}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors', msgType === t.id ? 'bg-[var(--brand-primary)] text-white' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]')}>
            <t.icon className="w-3 h-3" />{t.label}
          </button>
        ))}
      </div>
      {msgType === 'text' && (
        <textarea className="input w-full min-h-28 resize-none" placeholder="اكتب رسالتك هنا..." />
      )}
      {msgType === 'image' && (
        <div className="border-2 border-dashed border-[var(--border-strong)] rounded-xl p-8 text-center">
          <Image className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-2" />
          <p className="text-sm text-[var(--text-secondary)]">اسحب صورة أو <span className="text-[var(--brand-primary)] cursor-pointer">اختر ملف</span></p>
        </div>
      )}
      {msgType === 'file' && (
        <div className="border-2 border-dashed border-[var(--border-strong)] rounded-xl p-8 text-center">
          <FileText className="w-8 h-8 text-[var(--text-muted)] mx-auto mb-2" />
          <p className="text-sm text-[var(--text-secondary)]">اسحب ملفاً أو <span className="text-[var(--brand-primary)] cursor-pointer">اختر ملف</span></p>
        </div>
      )}
      {msgType === 'schedule' && (
        <div className="flex flex-col gap-2">
          <textarea className="input w-full min-h-20 resize-none" placeholder="نص الرسالة المجدولة..." />
          <input type="datetime-local" className="input" />
        </div>
      )}
      <Button className="w-full gap-2"><Send className="w-4 h-4" />إرسال للمجموعة</Button>
    </div>
  );
}

function TabAuto() {
  const automations = [
    { id: 'links',   icon: Link2,        label: 'مراقبة الروابط',    desc: 'رصد وحذف الروابط المحظورة تلقائياً', enabled: true  },
    { id: 'reply',   icon: MessageSquare, label: 'الرد التلقائي',    desc: 'الرد على الرسائل بكلمات مفتاحية', enabled: false },
    { id: 'welcome', icon: Bell,          label: 'الترحيب التلقائي', desc: 'إرسال رسالة ترحيب للأعضاء الجدد', enabled: true  },
    { id: 'spam',    icon: Shield,        label: 'الحماية من السبام', desc: 'حذف الرسائل المتكررة والمزعجة',  enabled: false },
    { id: 'filter',  icon: Filter,        label: 'فلترة الكلمات',    desc: 'منع كلمات معينة من المجموعة',     enabled: false },
  ];
  const [states, setStates] = useState(() => Object.fromEntries(automations.map(a => [a.id, a.enabled])));
  return (
    <div className="flex flex-col gap-2">
      {automations.map(a => (
        <div key={a.id} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)]">
          <div className="w-8 h-8 rounded-lg bg-[var(--brand-primary)]/10 flex items-center justify-center shrink-0">
            <a.icon className="w-4 h-4 text-[var(--brand-primary)]" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-bold text-[var(--text-primary)]">{a.label}</p>
            <p className="text-xs text-[var(--text-muted)]">{a.desc}</p>
          </div>
          <button onClick={() => setStates(s => ({ ...s, [a.id]: !s[a.id] }))}
            className={cn('w-11 h-6 rounded-full transition-all relative shrink-0', states[a.id] ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-overlay)]')}>
            <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', states[a.id] ? 'right-1' : 'left-1')} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ─────────────── Group Card ─────────────── */
function GroupCard({ group, onClick }: { group: any; onClick: () => void }) {
  const initials = group.name.split(' ').slice(0, 2).map((w: string) => w[0]).join('');
  const isActive = group.status === 'active';
  return (
    <div onClick={onClick} className="card p-4 cursor-pointer hover:border-[var(--brand-primary)]/40 transition-all hover:-translate-y-0.5 group">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-secondary)] flex items-center justify-center text-white font-bold text-sm shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="font-bold text-[var(--text-primary)] text-sm leading-snug line-clamp-2">{group.name}</p>
            <Badge variant="outline" className={cn('border-0 text-[10px] shrink-0 mt-0.5', isActive ? 'bg-green-500/10 text-green-500' : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]')}>
              {isActive ? 'نشطة' : 'غير نشطة'}
            </Badge>
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-1">{group.description}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { icon: Users,          value: group.members.toLocaleString(),    label: 'عضو' },
          { icon: MessageSquare,  value: group.messagesDay,                 label: 'رسالة/يوم' },
          { icon: Crown,          value: group.admins,                      label: 'مشرف' },
        ].map((s, i) => (
          <div key={i} className="bg-[var(--bg-elevated)] rounded-xl p-2 text-center">
            <s.icon className="w-3.5 h-3.5 text-[var(--brand-primary)] mx-auto mb-1" />
            <p className="text-sm font-bold text-[var(--text-primary)]">{s.value}</p>
            <p className="text-[10px] text-[var(--text-muted)]">{s.label}</p>
          </div>
        ))}
      </div>

      <ActivityBar level={group.activityLevel} />

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--border-default)]">
        <div className="flex items-center gap-1 text-[var(--text-muted)]">
          <Clock className="w-3 h-3" />
          <span className="text-xs">{group.lastActivity}</span>
        </div>
        <div className="flex items-center gap-1">
          {group.inviteLink && <Link2 className="w-3 h-3 text-[var(--brand-primary)]" />}
          <span className="text-xs font-medium text-[var(--brand-primary)] opacity-0 group-hover:opacity-100 transition-opacity">عرض التفاصيل ←</span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Group Detail Modal ─────────────── */
function GroupModal({ group, onClose }: { group: any; onClose: () => void }) {
  const [tab, setTab] = useState('info');
  const initials = group.name.split(' ').slice(0, 2).map((w: string) => w[0]).join('');

  const content: Record<string, React.ReactNode> = {
    info:    <TabInfo group={group} />,
    members: <TabMembers />,
    links:   <TabLinks />,
    export:  <TabExport />,
    stats:   <TabStats />,
    search:  <TabSearch />,
    send:    <TabSend />,
    auto:    <TabAuto />,
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg flex flex-col max-h-[90vh]" style={{ maxHeight: '90vh' }}>
        <DialogHeader className="pb-0">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-secondary)] flex items-center justify-center text-white font-bold shrink-0">
              {initials}
            </div>
            <div>
              <DialogTitle className="text-base leading-snug">{group.name}</DialogTitle>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{group.members.toLocaleString()} عضو • {group.admins} مشرف</p>
            </div>
          </div>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto py-1 shrink-0" style={{ scrollbarWidth: 'none' }}>
          {GROUP_TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn('flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-colors shrink-0',
                tab === t.id ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto">
          {content[tab]}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────── Main View ─────────────── */
export default function GroupsView({ accountId }: { accountId: string | null }) {
  const [filter, setFilter]           = useState('all');
  const [search, setSearch]           = useState('');
  const [selectedGroup, setSelectedGroup] = useState<any>(null);
  const [showFilters, setShowFilters] = useState(false);

  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">يجب اختيار حساب واتساب نشط لعرض المجموعات المنضم بها.</p>
        </div>
      </div>
    );
  }

  const filtered = useMemo(() => MOCK_GROUPS.filter(g => {
    if (filter === 'active'   && g.status !== 'active')   return false;
    if (filter === 'inactive' && g.status !== 'inactive') return false;
    if (filter === 'large'    && g.members < 200)         return false;
    if (filter === 'links'    && !g.inviteLink)           return false;
    if (filter === 'admin'    && g.admins < 1)            return false;
    if (search && !g.name.includes(search) && !g.id.includes(search)) return false;
    return true;
  }), [filter, search]);

  const stats = {
    total:   MOCK_GROUPS.length,
    members: MOCK_GROUPS.reduce((a, g) => a + g.members, 0),
    active:  MOCK_GROUPS.filter(g => g.status === 'active').length,
    links:   MOCK_LINKS.length,
    msgs:    MOCK_GROUPS.reduce((a, g) => a + g.messagesDay, 0),
    activity: Math.round(MOCK_GROUPS.reduce((a, g) => a + g.activityLevel, 0) / MOCK_GROUPS.length),
  };

  return (
    <div className="flex flex-col gap-5 h-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">المجموعات المنضم بها</h1>
          <p className="text-[var(--text-secondary)] mt-1 text-sm">عرض وإدارة جميع مجموعات واتساب الخاصة بالحساب المحدد</p>
        </div>
        <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={() => setShowFilters(!showFilters)}>
          <Filter className="w-4 h-4" />فلترة
          {showFilters ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        <StatCard icon={Users}          label="إجمالي المجموعات"   value={stats.total}                    color="text-[var(--brand-primary)]" />
        <StatCard icon={UserCheck}      label="إجمالي الأعضاء"      value={stats.members.toLocaleString()}  color="text-blue-400" />
        <StatCard icon={Activity}       label="المجموعات النشطة"    value={stats.active}                    color="text-green-400" />
        <StatCard icon={Link2}          label="الروابط المكتشفة"    value={stats.links}                     color="text-purple-400" />
        <StatCard icon={MessageSquare}  label="رسائل اليوم"         value={stats.msgs}                      color="text-yellow-400" />
        <StatCard icon={Zap}            label="معدل النشاط"          value={`${stats.activity}%`}            color="text-orange-400" />
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input className="input pr-10 w-full"
            placeholder="بحث بالاسم، المعرف، الرابط..."
            value={search} onChange={e => setSearch(e.target.value)} />
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
                className={cn('px-3 py-1.5 rounded-xl text-xs font-medium transition-colors', filter === f.id ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-default)]')}>
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Groups Grid */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center p-8">
              <Users className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" />
              <p className="text-[var(--text-secondary)]">لا توجد مجموعات تطابق البحث</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map(g => (
              <GroupCard key={g.id} group={g} onClick={() => setSelectedGroup(g)} />
            ))}
          </div>
        )}
      </div>

      {/* Count */}
      <div className="text-xs text-[var(--text-muted)] text-center pb-1">
        عرض {filtered.length} من {MOCK_GROUPS.length} مجموعة
      </div>

      {/* Detail Modal */}
      {selectedGroup && <GroupModal group={selectedGroup} onClose={() => setSelectedGroup(null)} />}
    </div>
  );
}

