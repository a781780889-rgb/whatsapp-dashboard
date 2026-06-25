import React, { useState, useEffect, useCallback } from 'react';
import { Calendar, Plus, Smartphone, Users, Play, Pause, Trash2, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/utils/cn';
import { authFetch, API } from '@/utils/api';

interface Schedule {
  id: string;
  name: string;
  status: string;
  ad_library_ids?: string[];
  target_group_jids: string[];
  active_days?: number[];
  publish_times?: string[];
  max_per_day?: number;
  run_count?: number;
  created_at: string;
}

interface Ad { id: string; name: string; content: string; is_active?: boolean; }
interface Group { id: string; name: string; }

const DAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export default function ScheduleDashboardView({ accountId }: { accountId: string | null }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // نموذج الجدولة — يدعم عدة إعلانات وعدة مجموعات
  const [form, setForm] = useState({
    name: '',
    ad_library_ids: [] as string[],       // مصفوفة إعلانات
    target_group_jids: [] as string[],    // مصفوفة مجموعات
    times: ['09:00'],
    days: [] as number[],
    send_to_members: false,
    exclude_admins: true,
    daily_limit: 500,
  });
  const [newTime, setNewTime] = useState('09:00');

  const loadData = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [schRes, adRes, grpRes] = await Promise.all([
        authFetch(`${API}/accounts/${accountId}/broadcast/schedules`),
        authFetch(`${API}/accounts/${accountId}/ads`),
        authFetch(`${API}/accounts/${accountId}/groups`),
      ]);
      const [schData, adData, grpData] = await Promise.all([schRes.json(), adRes.json(), grpRes.json()]);
      // الـ backend يرجع broadcasts وليس schedules
      if (schData.success) setSchedules(schData.broadcasts || schData.schedules || []);
      if (adData.success) setAds(adData.ads || []);
      if (grpData.success) setGroups(grpData.groups || []);
    } catch (e) {
      console.error('[Schedule] loadData error:', e);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { loadData(); }, [loadData]);

  const resetForm = () => {
    setForm({
      name: '',
      ad_library_ids: [],
      target_group_jids: [],
      times: ['09:00'],
      days: [],
      send_to_members: false,
      exclude_admins: true,
      daily_limit: 500,
    });
    setNewTime('09:00');
    setError('');
  };

  const handleCreate = async () => {
    if (!accountId) return;
    if (!form.name.trim()) { setError('اسم الجدولة مطلوب'); return; }
    if (form.ad_library_ids.length === 0) { setError('يجب اختيار إعلان واحد على الأقل'); return; }
    if (form.target_group_jids.length === 0) { setError('يجب اختيار مجموعة واحدة على الأقل'); return; }

    setSaving(true);
    setError('');
    try {
      const res = await authFetch(`${API}/accounts/${accountId}/broadcast/schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          ad_library_ids: form.ad_library_ids,         // مصفوفة إعلانات
          target_group_jids: form.target_group_jids,   // مصفوفة مجموعات
          active_days: form.days.length > 0 ? form.days : [0,1,2,3,4,5,6],
          publish_times: form.times,
          max_per_day: form.daily_limit,
          send_to_members: form.send_to_members,
          exclude_admins: form.exclude_admins,
          rotation_mode: 'sequential',
        }),
      });
      const data = await res.json();
      if (data.success) {
        setIsModalOpen(false);
        resetForm();
        await loadData();
      } else {
        setError(data.error || 'حدث خطأ أثناء الحفظ');
      }
    } catch (e: any) {
      setError('خطأ في الاتصال: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handlePause = async (id: string) => {
    if (!accountId) return;
    await authFetch(`${API}/accounts/${accountId}/broadcast/schedules/${id}/pause`, { method: 'POST' });
    await loadData();
  };

  const handleStart = async (id: string) => {
    if (!accountId) return;
    await authFetch(`${API}/accounts/${accountId}/broadcast/schedules/${id}/start`, { method: 'POST' });
    await loadData();
  };

  const handleDelete = async (id: string) => {
    if (!accountId || !confirm('هل تريد حذف هذه الجدولة؟')) return;
    await authFetch(`${API}/accounts/${accountId}/broadcast/schedules/${id}`, { method: 'DELETE' });
    setSchedules(prev => prev.filter(s => s.id !== id));
  };

  const toggleDay = (d: number) => {
    setForm(f => ({
      ...f,
      days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d],
    }));
  };

  // تبديل مجموعة (إضافة/إزالة)
  const toggleGroup = (id: string) => {
    setForm(f => ({
      ...f,
      target_group_jids: f.target_group_jids.includes(id)
        ? f.target_group_jids.filter(x => x !== id)
        : [...f.target_group_jids, id],
    }));
  };

  // تبديل إعلان (إضافة/إزالة) — يدعم عدة إعلانات
  const toggleAd = (id: string) => {
    setForm(f => ({
      ...f,
      ad_library_ids: f.ad_library_ids.includes(id)
        ? f.ad_library_ids.filter(x => x !== id)
        : [...f.ad_library_ids, id],
    }));
  };

  // اختيار / إلغاء اختيار كل الإعلانات
  const toggleAllAds = () => {
    const activeAds = ads.filter(a => a.is_active !== false);
    const allSelected = activeAds.every(a => form.ad_library_ids.includes(a.id));
    setForm(f => ({
      ...f,
      ad_library_ids: allSelected ? [] : activeAds.map(a => a.id),
    }));
  };

  // اختيار / إلغاء اختيار كل المجموعات
  const toggleAllGroups = () => {
    const allSelected = groups.every(g => form.target_group_jids.includes(g.id));
    setForm(f => ({
      ...f,
      target_group_jids: allSelected ? [] : groups.map(g => g.id),
    }));
  };

  const addTime = () => {
    if (!form.times.includes(newTime)) {
      setForm(f => ({ ...f, times: [...f.times, newTime] }));
    }
  };

  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">يجب اختيار حساب واتساب نشط لعرض وإدارة الجداول.</p>
        </div>
      </div>
    );
  }

  const total = schedules.length;
  const active = schedules.filter(s => s.status === 'active').length;
  const paused = schedules.filter(s => s.status !== 'active').length;

  const activeAds = ads.filter(a => a.is_active !== false);
  const allAdsSelected = activeAds.length > 0 && activeAds.every(a => form.ad_library_ids.includes(a.id));
  const allGroupsSelected = groups.length > 0 && groups.every(g => form.target_group_jids.includes(g.id));

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">النشر المجدول</h1>
          <p className="text-[var(--text-secondary)] mt-1">جدولة نشر الإعلانات آلياً حسب الأيام والأوقات</p>
        </div>
        <Button onClick={() => { resetForm(); setIsModalOpen(true); }}>
          <Plus className="w-4 h-4" />
          <span>جدولة جديدة</span>
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'إجمالي الجداول', value: total, color: 'text-blue-500' },
          { label: 'جداول نشطة', value: active, color: 'text-green-500' },
          { label: 'جداول موقوفة', value: paused, color: 'text-yellow-500' },
        ].map((stat, i) => (
          <Card key={i} className="card">
            <CardContent className="p-4 flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--text-secondary)]">{stat.label}</span>
              <span className={cn('text-2xl font-bold', stat.color)}>{stat.value}</span>
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
          ) : schedules.length === 0 ? (
            <div className="flex items-center justify-center p-12">
              <div className="text-center">
                <Calendar className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" />
                <p className="text-[var(--text-secondary)]">لا توجد جداول بعد</p>
                <Button className="mt-4" onClick={() => { resetForm(); setIsModalOpen(true); }}>
                  <Plus className="w-4 h-4" /> إنشاء جدولة
                </Button>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-[var(--bg-elevated)] sticky top-0 z-10 shadow-sm">
                <TableRow className="border-[var(--border-default)] hover:bg-transparent">
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الاسم</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الإعلانات</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">المجموعات</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الأوقات</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الأيام</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الحالة</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map(sch => {
                  const targetGroups = Array.isArray(sch.target_group_jids)
                    ? sch.target_group_jids
                    : (typeof sch.target_group_jids === 'string' ? JSON.parse(sch.target_group_jids || '[]') : []);
                  const adIds = Array.isArray(sch.ad_library_ids)
                    ? sch.ad_library_ids
                    : (typeof sch.ad_library_ids === 'string' ? JSON.parse(sch.ad_library_ids || '[]') : []);
                  const publishTimes = Array.isArray(sch.publish_times)
                    ? sch.publish_times
                    : (typeof sch.publish_times === 'string' ? JSON.parse(sch.publish_times || '[]') : []);
                  return (
                    <TableRow key={sch.id} className="border-[var(--border-default)] group">
                      <TableCell className="font-medium text-[var(--text-primary)] py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--brand-primary)] border border-[var(--border-default)]">
                            <Calendar className="w-4 h-4" />
                          </div>
                          {sch.name}
                        </div>
                      </TableCell>
                      <TableCell className="text-[var(--text-secondary)] text-sm">{adIds.length} إعلان</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 text-[var(--text-secondary)] text-sm">
                          <Users className="w-4 h-4" />
                          {targetGroups.length}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="px-2 py-0.5 bg-[var(--bg-elevated)] rounded border border-[var(--border-default)] text-xs dir-ltr font-mono text-[var(--text-primary)]">
                          {publishTimes.length > 0 ? `${publishTimes.length} وقت` : '—'}
                        </span>
                      </TableCell>
                      <TableCell className="text-[var(--text-secondary)] text-sm">
                        {Array.isArray(sch.active_days) && sch.active_days.length === 7
                          ? 'يومياً'
                          : Array.isArray(sch.active_days)
                          ? `${sch.active_days.length} أيام`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn(
                          'border-0 font-medium',
                          sch.status === 'active' ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500'
                        )}>
                          {sch.status === 'active' ? 'نشط' : 'موقوف'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                          {sch.status !== 'active' && (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-green-500 hover:text-green-500 hover:bg-green-500/10" onClick={() => handleStart(sch.id)}>
                              <Play className="w-4 h-4" />
                            </Button>
                          )}
                          {sch.status === 'active' && (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-yellow-500 hover:text-yellow-500 hover:bg-yellow-500/10" onClick={() => handlePause(sch.id)}>
                              <Pause className="w-4 h-4" />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-500 hover:bg-red-500/10" onClick={() => handleDelete(sch.id)}>
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

      <Dialog open={isModalOpen} onOpenChange={v => { if (!saving) { setIsModalOpen(v); if (!v) resetForm(); } }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>جدولة نشر جديدة</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-6 py-4 max-h-[70vh] overflow-y-auto pr-2">

            {/* اسم الجدولة */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">اسم الجدولة <span className="text-red-500">*</span></label>
              <input className="input" placeholder="مثال: النشرة الصباحية اليومية" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>

            {/* اختيار الإعلانات (متعدد) والحد اليومي */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">اختيار الإعلانات <span className="text-red-500">*</span></label>
                <div className="border border-[var(--border-default)] rounded-xl overflow-auto max-h-44">
                  {activeAds.length === 0 ? (
                    <p className="p-3 text-sm text-yellow-500">لا توجد إعلانات. أضف إعلاناً أولاً.</p>
                  ) : (
                    <>
                      {/* اختيار الكل */}
                      <label className="flex items-center gap-3 p-3 border-b border-[var(--border-default)] hover:bg-[var(--bg-elevated)] cursor-pointer bg-[var(--bg-elevated)]">
                        <input
                          type="checkbox"
                          checked={allAdsSelected}
                          onChange={toggleAllAds}
                          className="w-4 h-4 rounded"
                        />
                        <span className="text-sm font-semibold text-[var(--brand-primary)]">اختيار الكل ({activeAds.length})</span>
                      </label>
                      {activeAds.map(a => (
                        <label key={a.id} className="flex items-center gap-3 p-3 border-b border-[var(--border-default)] last:border-0 hover:bg-[var(--bg-elevated)] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.ad_library_ids.includes(a.id)}
                            onChange={() => toggleAd(a.id)}
                            className="w-4 h-4 rounded"
                          />
                          <span className="text-sm text-[var(--text-primary)]">{a.name}</span>
                        </label>
                      ))}
                    </>
                  )}
                </div>
                {form.ad_library_ids.length > 0 && (
                  <p className="text-xs text-[var(--brand-primary)]">تم اختيار {form.ad_library_ids.length} إعلان</p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">الحد الأقصى يومياً</label>
                <input className="input" type="number" value={form.daily_limit} onChange={e => setForm(f => ({ ...f, daily_limit: Number(e.target.value) }))} />
              </div>
            </div>

            {/* المجموعات المستهدفة (متعددة) */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">المجموعات المستهدفة <span className="text-red-500">*</span></label>
              <div className="border border-[var(--border-default)] rounded-xl overflow-auto max-h-48">
                {groups.length === 0 ? (
                  <p className="p-3 text-sm text-[var(--text-muted)]">لا توجد مجموعات متاحة</p>
                ) : (
                  <>
                    {/* اختيار الكل */}
                    <label className="flex items-center gap-3 p-3 border-b border-[var(--border-default)] hover:bg-[var(--bg-elevated)] cursor-pointer bg-[var(--bg-elevated)]">
                      <input
                        type="checkbox"
                        checked={allGroupsSelected}
                        onChange={toggleAllGroups}
                        className="w-4 h-4 rounded"
                      />
                      <span className="text-sm font-semibold text-[var(--brand-primary)]">اختيار الكل ({groups.length})</span>
                    </label>
                    {groups.map(g => (
                      <label key={g.id} className="flex items-center gap-3 p-3 border-b border-[var(--border-default)] last:border-0 hover:bg-[var(--bg-elevated)] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.target_group_jids.includes(g.id)}
                          onChange={() => toggleGroup(g.id)}
                          className="w-4 h-4 rounded"
                        />
                        <span className="text-sm text-[var(--text-primary)]">{g.name}</span>
                      </label>
                    ))}
                  </>
                )}
              </div>
              {form.target_group_jids.length > 0 && (
                <p className="text-xs text-[var(--brand-primary)]">تم اختيار {form.target_group_jids.length} مجموعة</p>
              )}
            </div>

            {/* أيام النشر */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">أيام النشر</label>
              <div className="flex flex-wrap gap-2">
                {DAYS_AR.map((day, i) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(i)}
                    className={cn('px-4 py-2 rounded-lg border text-sm transition-colors', form.days.includes(i)
                      ? 'bg-[var(--brand-primary-light)] border-[var(--brand-primary)] text-[var(--brand-primary)]'
                      : 'bg-[var(--bg-elevated)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                    )}
                  >
                    {day}
                  </button>
                ))}
              </div>
              <p className="text-xs text-[var(--text-muted)]">اتركها فارغة للنشر يومياً</p>
            </div>

            {/* أوقات النشر */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">أوقات النشر</label>
              <div className="flex items-center gap-2">
                <input type="time" className="input w-32 dir-ltr text-center" value={newTime} onChange={e => setNewTime(e.target.value)} />
                <Button type="button" variant="outline" className="px-3" onClick={addTime}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {form.times.map(t => (
                  <div key={t} className="px-3 py-1.5 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-md text-sm font-mono dir-ltr flex items-center gap-2">
                    {t}
                    <button type="button" onClick={() => setForm(f => ({ ...f, times: f.times.filter(x => x !== t) }))}>
                      <Trash2 className="w-3 h-3 text-red-500 cursor-pointer" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* خيارات الإرسال */}
            <div className="flex flex-col gap-3">
              <h4 className="text-sm font-semibold text-[var(--text-primary)] border-b border-[var(--border-default)] pb-2">خيارات الإرسال</h4>
              <label className="flex items-center justify-between p-3 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)] cursor-pointer hover:border-[var(--brand-primary)] transition-colors" onClick={() => setForm(f => ({ ...f, send_to_members: !f.send_to_members }))}>
                <div>
                  <p className="font-medium text-[var(--text-primary)] text-sm">إرسال للأعضاء (خاص)</p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">يُرسل رسالة خاصة لكل عضو بالإضافة للمجموعة</p>
                </div>
                <div className={cn('w-10 h-6 rounded-full relative transition-colors', form.send_to_members ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-surface)] border border-[var(--border-strong)]')}>
                  <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', form.send_to_members ? 'right-1' : 'left-1')} />
                </div>
              </label>
              <label className="flex items-center justify-between p-3 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)] cursor-pointer hover:border-orange-400 transition-colors" onClick={() => setForm(f => ({ ...f, exclude_admins: !f.exclude_admins }))}>
                <div>
                  <p className="font-medium text-[var(--text-primary)] text-sm">استبعاد المشرفين</p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">لا يُرسل للمشرفين عند الإرسال الخاص للأعضاء</p>
                </div>
                <div className={cn('w-10 h-6 rounded-full relative transition-colors', form.exclude_admins ? 'bg-orange-500' : 'bg-[var(--bg-surface)] border border-[var(--border-strong)]')}>
                  <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', form.exclude_admins ? 'right-1' : 'left-1')} />
                </div>
              </label>
            </div>

            {error && <p className="text-sm text-red-500 bg-red-500/10 p-3 rounded-lg">{error}</p>}

            <div className="pt-4 border-t border-[var(--border-default)] flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setIsModalOpen(false); resetForm(); }} disabled={saving}>إلغاء</Button>
              <Button onClick={handleCreate} disabled={saving}>
                {saving ? <><Loader2 className="w-4 h-4 animate-spin ml-2" />جارٍ الحفظ...</> : 'حفظ الجدولة'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
