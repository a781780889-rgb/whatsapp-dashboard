import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Play, Pause, Trash2, Plus, Megaphone, Smartphone, Check, Loader2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import { authFetch, API } from '@/utils/api';

interface Campaign {
  id: string;
  name: string;
  status: string;
  total_targets: number;
  sent_count: number;
  failed_count: number;
  ad_library_id?: string;
  created_at: string;
}

interface Ad { id: string; name: string; content: string; }
interface Group { id: string; name: string; participants_count?: number; }

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active:    { label: 'نشطة',    cls: 'bg-green-500/10 text-green-500' },
    running:   { label: 'تعمل',    cls: 'bg-blue-500/10 text-blue-500' },
    paused:    { label: 'متوقفة',  cls: 'bg-yellow-500/10 text-yellow-500' },
    completed: { label: 'مكتملة',  cls: 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]' },
    pending:   { label: 'معلقة',   cls: 'bg-purple-500/10 text-purple-500' },
    failed:    { label: 'فشلت',    cls: 'bg-red-500/10 text-red-500' },
  };
  const cfg = map[status] || { label: status, cls: 'bg-[var(--bg-elevated)] text-[var(--text-muted)]' };
  return (
    <Badge variant="outline" className={cn('border-0 font-medium', cfg.cls)}>{cfg.label}</Badge>
  );
}

export default function CampaignsView({ accountId }: { accountId: string | null }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    name: '',
    ad_library_id: '',
    target_type: 'group_members' as 'group_members',
    target_ids: [] as string[],
    batch_size: 10,
    interval_seconds: 15,
    daily_limit: 500,
    exclude_admins: true,
    exclude_duplicates: true,
  });

  const loadData = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [campRes, adRes, grpRes] = await Promise.all([
        authFetch(`${API}/accounts/${accountId}/campaigns`),
        authFetch(`${API}/accounts/${accountId}/ads`),
        authFetch(`${API}/accounts/${accountId}/groups`),
      ]);
      const [campData, adData, grpData] = await Promise.all([campRes.json(), adRes.json(), grpRes.json()]);
      if (campData.success) setCampaigns(campData.campaigns || []);
      if (adData.success) setAds(adData.ads || []);
      if (grpData.success) setGroups(grpData.groups || []);
    } catch (e) {
      console.error('[Campaigns] loadData error:', e);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCreateCampaign = async () => {
    if (!accountId) return;
    if (!form.name.trim()) { setError('اسم الحملة مطلوب'); return; }
    if (!form.ad_library_id) { setError('يجب اختيار إعلان'); return; }
    if (form.target_ids.length === 0) { setError('يجب اختيار مجموعة واحدة على الأقل'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await authFetch(`${API}/accounts/${accountId}/campaigns`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          adLibraryId: form.ad_library_id,
          targetType: form.target_type,
          targetIds: form.target_ids,
          batchSize: form.batch_size,
          intervalSeconds: form.interval_seconds,
          dailyLimit: form.daily_limit,
          excludeAdmins: form.exclude_admins,
          excludeDuplicates: form.exclude_duplicates,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setIsWizardOpen(false);
        setStep(1);
        setForm({ name: '', ad_library_id: '', target_type: 'group_members', target_ids: [], batch_size: 10, interval_seconds: 15, daily_limit: 500, exclude_admins: true, exclude_duplicates: true });
        await loadData();
      } else {
        setError(data.error || 'حدث خطأ أثناء إنشاء الحملة');
      }
    } catch (e: any) {
      setError('خطأ في الاتصال: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handlePause = async (id: string) => {
    if (!accountId) return;
    await authFetch(`${API}/accounts/${accountId}/campaigns/${id}/pause`, { method: 'POST' });
    await loadData();
  };

  const handleStart = async (id: string) => {
    if (!accountId) return;
    await authFetch(`${API}/accounts/${accountId}/campaigns/${id}/start`, { method: 'POST' });
    await loadData();
  };

  const handleDelete = async (id: string) => {
    if (!accountId || !confirm('هل تريد حذف هذه الحملة؟')) return;
    await authFetch(`${API}/accounts/${accountId}/campaigns/${id}`, { method: 'DELETE' });
    setCampaigns(prev => prev.filter(c => c.id !== id));
  };

  const toggleGroup = (id: string) => {
    setForm(f => ({
      ...f,
      target_ids: f.target_ids.includes(id) ? f.target_ids.filter(x => x !== id) : [...f.target_ids, id],
    }));
  };

  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">يجب اختيار حساب واتساب نشط من الشريط العلوي لعرض وإدارة الحملات الخاصة به.</p>
        </div>
      </div>
    );
  }

  const total = campaigns.length;
  const active = campaigns.filter(c => ['active', 'running'].includes(c.status)).length;
  const paused = campaigns.filter(c => c.status === 'paused').length;
  const completed = campaigns.filter(c => c.status === 'completed').length;

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">الحملات</h1>
          <p className="text-[var(--text-secondary)] mt-1">إدارة حملات الإرسال الجماعي</p>
        </div>
        <Button onClick={() => { setStep(1); setError(''); setIsWizardOpen(true); }}>
          <Plus className="w-4 h-4" />
          <span>حملة جديدة</span>
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'إجمالي', value: total, color: 'text-blue-500' },
          { label: 'نشطة', value: active, color: 'text-green-500' },
          { label: 'متوقفة', value: paused, color: 'text-yellow-500' },
          { label: 'مكتملة', value: completed, color: 'text-gray-500' },
        ].map((stat, i) => (
          <Card key={i} className="card">
            <CardContent className="p-4 flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--text-secondary)]">{stat.label}</span>
              <span className={cn('text-xl font-bold', stat.color)}>{stat.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="card flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center p-12">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-primary)]" />
            </div>
          ) : campaigns.length === 0 ? (
            <div className="flex items-center justify-center p-12">
              <div className="text-center">
                <Megaphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" />
                <p className="text-[var(--text-secondary)]">لا توجد حملات بعد</p>
                <Button className="mt-4" onClick={() => { setStep(1); setIsWizardOpen(true); }}>
                  <Plus className="w-4 h-4" /> إنشاء حملة
                </Button>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-[var(--bg-elevated)] sticky top-0 z-10 shadow-sm">
                <TableRow className="border-[var(--border-default)] hover:bg-transparent">
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">اسم الحملة</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">المستهدفون</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">المُرسَل</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">التقدم</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الحالة</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map(camp => {
                  const progress = camp.total_targets > 0 ? Math.round((camp.sent_count / camp.total_targets) * 100) : 0;
                  return (
                    <TableRow key={camp.id} className="border-[var(--border-default)] group">
                      <TableCell className="font-medium text-[var(--text-primary)] py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--brand-primary)]">
                            <Megaphone className="w-4 h-4" />
                          </div>
                          {camp.name}
                        </div>
                      </TableCell>
                      <TableCell className="text-[var(--text-secondary)]">{camp.total_targets.toLocaleString()}</TableCell>
                      <TableCell className="text-[var(--text-secondary)]">{camp.sent_count.toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={progress} className="w-24" />
                          <span className="text-xs text-[var(--text-muted)] w-8">{progress}%</span>
                        </div>
                      </TableCell>
                      <TableCell><StatusBadge status={camp.status} /></TableCell>
                      <TableCell>
                        <div className="flex gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                          {!['active', 'running', 'completed'].includes(camp.status) && (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-green-500 hover:text-green-500 hover:bg-green-500/10" onClick={() => handleStart(camp.id)}>
                              <Play className="w-4 h-4" />
                            </Button>
                          )}
                          {['active', 'running'].includes(camp.status) && (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-yellow-500 hover:text-yellow-500 hover:bg-yellow-500/10" onClick={() => handlePause(camp.id)}>
                              <Pause className="w-4 h-4" />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-500 hover:bg-red-500/10" onClick={() => handleDelete(camp.id)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>

      {/* Wizard */}
      <Dialog open={isWizardOpen} onOpenChange={v => { if (!saving) { setIsWizardOpen(v); if (!v) setStep(1); } }}>
        <DialogContent className="sm:max-w-2xl min-h-[500px] flex flex-col">
          <DialogHeader>
            <DialogTitle>حملة جديدة</DialogTitle>
          </DialogHeader>

          <div className="flex items-center justify-center gap-2 py-4">
            {[1, 2, 3, 4].map(s => (
              <React.Fragment key={s}>
                <div className={cn('w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors',
                  step === s ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                  : step > s ? 'bg-[var(--brand-primary-light)] text-[var(--brand-primary)]'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]')}>
                  {step > s ? <Check className="w-4 h-4" /> : s}
                </div>
                {s < 4 && <div className={cn('w-12 h-1 rounded-full transition-colors', step > s ? 'bg-[var(--brand-primary-light)]' : 'bg-[var(--bg-elevated)]')} />}
              </React.Fragment>
            ))}
          </div>

          <div className="flex-1 overflow-auto py-2">
            {step === 1 && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">اسم الحملة <span className="text-red-500">*</span></label>
                  <input className="input" placeholder="أدخل اسماً مميزاً للحملة..." value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-2 mt-4">
                  <label className="text-sm font-medium">اختر الإعلان من المكتبة <span className="text-red-500">*</span></label>
                  {ads.length === 0 ? (
                    <p className="text-sm text-yellow-500 p-3 bg-yellow-500/10 rounded-lg">لا توجد إعلانات. أضف إعلاناً من مكتبة الإعلانات أولاً.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 max-h-64 overflow-auto">
                      {ads.map(ad => (
                        <div
                          key={ad.id}
                          onClick={() => setForm(f => ({ ...f, ad_library_id: ad.id }))}
                          className={cn('border rounded-xl p-4 cursor-pointer transition-colors', form.ad_library_id === ad.id
                            ? 'border-[var(--brand-primary)] bg-[var(--brand-primary-light)]'
                            : 'border-[var(--border-default)] hover:border-[var(--brand-primary)]'
                          )}
                        >
                          <div className="font-bold text-[var(--text-primary)]">{ad.name}</div>
                          <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">{ad.content}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {step === 2 && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <h3 className="font-bold text-[var(--text-primary)]">اختيار المجموعات المستهدفة</h3>
                <div className="border border-[var(--border-default)] rounded-xl overflow-auto max-h-72">
                  {groups.length === 0 ? (
                    <p className="p-4 text-sm text-[var(--text-muted)]">لا توجد مجموعات</p>
                  ) : groups.map(g => (
                    <label key={g.id} className="flex items-center gap-3 p-3 border-b border-[var(--border-default)] last:border-0 hover:bg-[var(--bg-elevated)] cursor-pointer">
                      <input type="checkbox" checked={form.target_ids.includes(g.id)} onChange={() => toggleGroup(g.id)} className="w-4 h-4 rounded" />
                      <div className="flex-1">
                        <p className="font-medium text-[var(--text-primary)]">{g.name}</p>
                        {g.participants_count !== undefined && <p className="text-xs text-[var(--text-muted)]">{g.participants_count} عضو</p>}
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {step === 3 && (
              <div className="flex flex-col gap-6 animate-fade-in">
                <h3 className="font-bold text-[var(--text-primary)]">قواعد الاستبعاد والإرسال</h3>
                <div className="flex flex-col gap-4">
                  <label className="flex items-center justify-between p-4 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)] cursor-pointer" onClick={() => setForm(f => ({ ...f, exclude_admins: !f.exclude_admins }))}>
                    <div>
                      <p className="font-medium text-[var(--text-primary)]">استبعاد المشرفين</p>
                      <p className="text-xs text-[var(--text-muted)] mt-1">لا ترسل رسائل لمشرفي المجموعات.</p>
                    </div>
                    <div className={cn('w-10 h-6 rounded-full relative transition-colors', form.exclude_admins ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-surface)] border border-[var(--border-strong)]')}>
                      <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', form.exclude_admins ? 'right-1' : 'left-1')} />
                    </div>
                  </label>
                  <label className="flex items-center justify-between p-4 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)] cursor-pointer" onClick={() => setForm(f => ({ ...f, exclude_duplicates: !f.exclude_duplicates }))}>
                    <div>
                      <p className="font-medium text-[var(--text-primary)]">منع التكرار</p>
                      <p className="text-xs text-[var(--text-muted)] mt-1">إرسال رسالة واحدة فقط للرقم حتى لو تواجد في عدة مجموعات.</p>
                    </div>
                    <div className={cn('w-10 h-6 rounded-full relative transition-colors', form.exclude_duplicates ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-surface)] border border-[var(--border-strong)]')}>
                      <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', form.exclude_duplicates ? 'right-1' : 'left-1')} />
                    </div>
                  </label>
                </div>
              </div>
            )}
            {step === 4 && (
              <div className="flex flex-col gap-6 animate-fade-in">
                <h3 className="font-bold text-[var(--text-primary)]">إعدادات الإرسال للحماية</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">الفاصل بين الرسائل (ثانية)</label>
                    <select className="input" value={form.interval_seconds} onChange={e => setForm(f => ({ ...f, interval_seconds: Number(e.target.value) }))}>
                      <option value={10}>10 ثواني (سريع)</option>
                      <option value={15}>15 ثانية (موصى به)</option>
                      <option value={30}>30 ثانية (آمن)</option>
                      <option value={60}>60 ثانية (أكثر أماناً)</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">الحد الأقصى اليومي</label>
                    <input className="input" type="number" value={form.daily_limit} onChange={e => setForm(f => ({ ...f, daily_limit: Number(e.target.value) }))} />
                  </div>
                </div>
                {error && <p className="text-sm text-red-500 bg-red-500/10 p-3 rounded-lg">{error}</p>}
              </div>
            )}
          </div>

          <div className="flex justify-between mt-auto pt-4 border-t border-[var(--border-default)]">
            <Button variant="outline" onClick={() => step > 1 ? setStep(step - 1) : setIsWizardOpen(false)} disabled={saving}>
              {step > 1 ? 'السابق' : 'إلغاء'}
            </Button>
            <Button
              onClick={() => step < 4 ? setStep(step + 1) : handleCreateCampaign()}
              disabled={saving || (step === 1 && (!form.name.trim() || !form.ad_library_id)) || (step === 2 && form.target_ids.length === 0)}
            >
              {saving ? <><Loader2 className="w-4 h-4 animate-spin ml-2" />جارٍ الإنشاء...</> : step < 4 ? 'التالي' : 'إطلاق الحملة'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
