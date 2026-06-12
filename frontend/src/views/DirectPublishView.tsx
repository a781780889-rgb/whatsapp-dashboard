import React, { useState, useEffect } from 'react';
import { Smartphone, Send, Search, Users, ChevronDown, ChevronUp, MessageSquare, UserX } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/utils/cn';

const API = (path: string, opts?: RequestInit) =>
  fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, ...opts });

interface Group { id: string; name: string; participants_count?: number; }
interface Ad    { id: string; name: string; content: string; }

export default function DirectPublishView({ accountId, accounts }: { accountId: string | null, accounts: any[] }) {
  const [message, setMessage]               = useState('');
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [groups, setGroups]                 = useState<Group[]>([]);
  const [ads, setAds]                       = useState<Ad[]>([]);
  const [selectedAd, setSelectedAd]         = useState<string>('');
  const [search, setSearch]                 = useState('');
  const [sendToMembers, setSendToMembers]   = useState(false);
  const [excludeAdmins, setExcludeAdmins]   = useState(true);
  const [sending, setSending]               = useState(false);
  const [logs, setLogs]                     = useState<any[]>([]);
  const [showLog, setShowLog]               = useState(false);
  const [lastResult, setLastResult]         = useState<string>('');

  useEffect(() => {
    if (!accountId) return;
    API(`/accounts/${accountId}/groups`).then(r => r.json()).then(d => setGroups(d.groups || []));
    API(`/accounts/${accountId}/ads`).then(r => r.json()).then(d => setAds(d.ads || []));
    API(`/accounts/${accountId}/broadcast/log`).then(r => r.json()).then(d => setLogs(d.logs || []));
  }, [accountId]);

  const toggleGroup = (id: string) => {
    setSelectedGroups(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const filtered = groups.filter(g => g.name.toLowerCase().includes(search.toLowerCase()));
    if (filtered.every(g => selectedGroups.has(g.id))) {
      setSelectedGroups(new Set());
    } else {
      setSelectedGroups(new Set(filtered.map(g => g.id)));
    }
  };

  const handleImportAd = (adId: string) => {
    const ad = ads.find(a => a.id === adId);
    if (ad) { setSelectedAd(adId); setMessage(ad.content); }
  };

  const handleSend = async () => {
    if (selectedGroups.size === 0) return;
    setSending(true);
    setLastResult('');
    try {
      const body: any = {
        target_group_jids: Array.from(selectedGroups),
        send_to_members: sendToMembers,
        exclude_admins: excludeAdmins,
      };
      if (selectedAd) body.ad_library_id = selectedAd;
      else body.custom_content = message;

      const r = await API(`/accounts/${accountId}/broadcast/direct`, { method: 'POST', body: JSON.stringify(body) });
      const d = await r.json();
      setLastResult(d.message || (d.success ? 'تم الإرسال' : d.error));
      if (d.success) {
        const logsR = await API(`/accounts/${accountId}/broadcast/log`);
        const logsD = await logsR.json();
        setLogs(logsD.logs || []);
        setShowLog(true);
      }
    } catch (e: any) {
      setLastResult('خطأ في الإرسال: ' + e.message);
    }
    setSending(false);
  };

  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">يجب اختيار حساب واتساب نشط للبدء في النشر المباشر.</p>
        </div>
      </div>
    );
  }

  const selectedAccount = accounts.find(a => a.id === accountId);
  const filteredGroups = groups.filter(g => g.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">النشر المباشر</h1>
          <p className="text-[var(--text-secondary)] mt-1">إرسال رسالة فورية للمجموعات المحددة عبر {selectedAccount?.name}</p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0">
        
        {/* Left: Groups */}
        <Card className="card w-full lg:w-1/3 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-[var(--border-default)] bg-[var(--bg-app)]">
            <h3 className="font-bold text-[var(--text-primary)] mb-3 flex items-center gap-2">
              <Users className="w-4 h-4 text-[var(--text-muted)]" /> المجموعات
              {selectedGroups.size > 0 && (
                <Badge className="bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] border-0 mr-auto">{selectedGroups.size} محددة</Badge>
              )}
            </h3>
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input className="input pr-9 bg-[var(--bg-surface)]" placeholder="بحث في المجموعات..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
            <label onClick={toggleAll} className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-elevated)] cursor-pointer">
              <input type="checkbox" readOnly checked={filteredGroups.length > 0 && filteredGroups.every(g => selectedGroups.has(g.id))} className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)]" />
              <span className="font-bold text-[var(--brand-primary)]">تحديد الكل ({filteredGroups.length})</span>
            </label>
            <div className="w-full h-px bg-[var(--border-default)] my-1" />
            {filteredGroups.length === 0 && <p className="text-center text-sm text-[var(--text-muted)] py-8">لا توجد مجموعات</p>}
            {filteredGroups.map(g => (
              <label key={g.id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-elevated)] cursor-pointer transition-colors">
                <input type="checkbox" checked={selectedGroups.has(g.id)} onChange={() => toggleGroup(g.id)} className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)]" />
                <div className="flex-1">
                  <p className="font-medium text-[var(--text-primary)] text-sm truncate">{g.name}</p>
                  {g.participants_count && <p className="text-xs text-[var(--text-muted)] mt-0.5">{g.participants_count} عضو</p>}
                </div>
              </label>
            ))}
          </div>
        </Card>

        {/* Right: Message + Options */}
        <Card className="card w-full lg:w-2/3 flex flex-col overflow-hidden">
          <div className="p-6 flex-1 overflow-y-auto flex flex-col gap-6">
            
            {/* Message content */}
            <div className="flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <label className="text-sm font-medium text-[var(--text-primary)]">محتوى الرسالة</label>
                <select className="input h-8 w-48 text-sm" value={selectedAd} onChange={e => handleImportAd(e.target.value)}>
                  <option value="">استيراد من المكتبة...</option>
                  {ads.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <textarea
                className="input min-h-[120px] font-mono text-sm leading-relaxed"
                placeholder="اكتب رسالتك هنا..."
                value={message}
                onChange={e => { setMessage(e.target.value); setSelectedAd(''); }}
              />
            </div>

            {/* ━━ خيارات الإرسال ━━ */}
            <div className="flex flex-col gap-3">
              <h4 className="text-sm font-semibold text-[var(--text-primary)] border-b border-[var(--border-default)] pb-2">خيارات الإرسال</h4>

              {/* Toggle: إرسال للمجموعة */}
              <div className="flex items-center justify-between p-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)]">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <Users className="w-4 h-4 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">النشر في المجموعة</p>
                    <p className="text-xs text-[var(--text-muted)]">إرسال الرسالة لـ chat المجموعة</p>
                  </div>
                </div>
                <div className="w-10 h-6 bg-[var(--brand-primary)] rounded-full relative opacity-50 cursor-not-allowed">
                  <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full" />
                </div>
              </div>

              {/* Toggle: إرسال للأعضاء خاص */}
              <div
                onClick={() => setSendToMembers(!sendToMembers)}
                className={cn(
                  "flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all",
                  sendToMembers
                    ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5"
                    : "border-[var(--border-default)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", sendToMembers ? "bg-[var(--brand-primary)]/10" : "bg-[var(--bg-surface)]")}>
                    <MessageSquare className={cn("w-4 h-4", sendToMembers ? "text-[var(--brand-primary)]" : "text-[var(--text-muted)]")} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">إرسال للأعضاء (خاص)</p>
                    <p className="text-xs text-[var(--text-muted)]">إرسال رسالة خاصة لكل عضو في المجموعة</p>
                  </div>
                </div>
                <div className={cn("w-10 h-6 rounded-full relative transition-colors", sendToMembers ? "bg-[var(--brand-primary)]" : "bg-[var(--bg-surface)] border border-[var(--border-strong)]")}>
                  <div className={cn("absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm", sendToMembers ? "right-1" : "left-1")} />
                </div>
              </div>

              {/* Toggle: استبعاد المشرفين — يظهر فقط إذا كان sendToMembers مفعلاً */}
              {sendToMembers && (
                <div
                  onClick={() => setExcludeAdmins(!excludeAdmins)}
                  className={cn(
                    "flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all mr-6",
                    excludeAdmins
                      ? "border-orange-500/40 bg-orange-500/5"
                      : "border-[var(--border-default)] bg-[var(--bg-elevated)] hover:border-[var(--border-strong)]"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", excludeAdmins ? "bg-orange-500/10" : "bg-[var(--bg-surface)]")}>
                      <UserX className={cn("w-4 h-4", excludeAdmins ? "text-orange-500" : "text-[var(--text-muted)]")} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">استبعاد المشرفين</p>
                      <p className="text-xs text-[var(--text-muted)]">لا ترسل للمشرفين عند الإرسال الخاص</p>
                    </div>
                  </div>
                  <div className={cn("w-10 h-6 rounded-full relative transition-colors", excludeAdmins ? "bg-orange-500" : "bg-[var(--bg-surface)] border border-[var(--border-strong)]")}>
                    <div className={cn("absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm", excludeAdmins ? "right-1" : "left-1")} />
                  </div>
                </div>
              )}
            </div>

            {/* Summary badge */}
            {selectedGroups.size > 0 && (
              <div className="rounded-xl border border-[var(--brand-primary)]/20 bg-[var(--brand-primary)]/5 p-3 flex items-center gap-3">
                <div className="flex flex-col gap-0.5 flex-1">
                  <p className="text-sm font-medium text-[var(--text-primary)]">ملخص الإرسال</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    ✅ {selectedGroups.size} مجموعة
                    {sendToMembers && <> &nbsp;+&nbsp; ✉️ رسائل خاصة لأعضاء كل مجموعة {excludeAdmins ? '(بدون مشرفين)' : '(بما فيهم المشرفين)'}</>}
                  </p>
                </div>
              </div>
            )}

            <div className="mt-auto pt-4">
              <Button
                disabled={selectedGroups.size === 0 || sending || (!message && !selectedAd)}
                onClick={handleSend}
                className="w-full h-14 text-lg font-bold shadow-[var(--shadow-glow)] bg-gradient-to-r from-[var(--brand-primary)] to-[#008f6e] disabled:opacity-50"
              >
                {sending ? (
                  <span className="flex items-center gap-2"><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> جاري الإرسال...</span>
                ) : (
                  <><Send className="w-5 h-5 ml-2" /> إرسال الآن ({selectedGroups.size} مجموعة{sendToMembers ? ' + أعضاء' : ''})</>
                )}
              </Button>
              {lastResult && (
                <p className={cn("mt-3 text-center text-sm font-medium", lastResult.includes('خطأ') ? 'text-red-500' : 'text-green-500')}>
                  {lastResult}
                </p>
              )}
            </div>
          </div>

          {/* Publish Log Strip */}
          <div
            className="border-t border-[var(--border-default)] bg-[var(--bg-app)] p-3 px-6 flex items-center justify-between cursor-pointer hover:bg-[var(--bg-elevated)] transition-colors"
            onClick={() => setShowLog(!showLog)}
          >
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-medium text-[var(--text-secondary)]">سجل الإرسال ({logs.length})</span>
            </div>
            {showLog ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" />}
          </div>
          {showLog && (
            <div className="border-t border-[var(--border-default)] max-h-48 overflow-y-auto bg-[var(--bg-app)]">
              {logs.length === 0 && <p className="text-center text-sm text-[var(--text-muted)] py-6">لا يوجد سجل بعد</p>}
              {logs.map((log, i) => (
                <div key={i} className="flex items-center justify-between px-6 py-2.5 border-b border-[var(--border-default)] last:border-0">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className={cn("border-0 text-xs", log.status === 'sent' ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500')}>
                      {log.status === 'sent' ? 'أُرسل' : 'جزئي'}
                    </Badge>
                    <span className="text-sm text-[var(--text-primary)]">{log.ad_name || 'رسالة مخصصة'}</span>
                    {log.send_to_members && <Badge className="bg-blue-500/10 text-blue-500 border-0 text-xs">+ أعضاء ({log.members_sent || 0})</Badge>}
                  </div>
                  <span className="text-xs text-[var(--text-muted)]">{log.target_group_jids?.length || 0} مجموعة</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
