import React, { useState, useEffect, useCallback } from 'react';
import { Search, Plus, Edit2, Trash2, Eye, Star, Smartphone, Loader2, ToggleLeft, ToggleRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/utils/cn';
import { authFetch, API } from '@/utils/api';

interface Ad {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  priority: number;
  use_count: number;
  tags: string;
  media_paths: string[];
  links: string[];
  created_at: string;
}

interface AdForm {
  name: string;
  content: string;
  priority: number;
  tags: string;
  is_active: boolean;
}

const defaultForm: AdForm = { name: '', content: '', priority: 5, tags: '', is_active: true };

export default function AdLibraryView({ accountId }: { accountId: string | null }) {
  const [ads, setAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [selectedAd, setSelectedAd] = useState<Ad | null>(null);
  const [editingAd, setEditingAd] = useState<Ad | null>(null);
  const [form, setForm] = useState<AdForm>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadAds = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      console.log('[AdLibrary] Loading ads for account:', accountId);
      const res = await authFetch(`${API}/accounts/${accountId}/ads`);
      const data = await res.json();
      console.log('[AdLibrary] Loaded ads:', data);
      if (data.success) {
        setAds(data.ads || []);
      }
    } catch (e) {
      console.error('[AdLibrary] loadAds error:', e);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    loadAds();
  }, [loadAds]);

  const openCreate = () => {
    setEditingAd(null);
    setForm(defaultForm);
    setError('');
    setIsModalOpen(true);
  };

  const openEdit = (ad: Ad) => {
    setEditingAd(ad);
    setForm({ name: ad.name, content: ad.content, priority: ad.priority, tags: ad.tags, is_active: ad.is_active });
    setError('');
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    if (!accountId) return;
    if (!form.name.trim()) { setError('اسم الإعلان مطلوب'); return; }
    setSaving(true);
    setError('');
    try {
      let res: Response;
      if (editingAd) {
        console.log('[AdLibrary] Updating ad:', editingAd.id);
        res = await authFetch(`${API}/accounts/${accountId}/ads/${editingAd.id}`, {
          method: 'PUT',
          body: JSON.stringify(form),
        });
      } else {
        console.log('[AdLibrary] Creating new ad');
        res = await authFetch(`${API}/accounts/${accountId}/ads`, {
          method: 'POST',
          body: JSON.stringify(form),
        });
      }
      const data = await res.json();
      console.log('[AdLibrary] Save result:', data);
      if (data.success) {
        setIsModalOpen(false);
        await loadAds(); // إعادة تحميل القائمة فوراً
      } else {
        setError(data.error || 'حدث خطأ أثناء الحفظ');
      }
    } catch (e: any) {
      setError('خطأ في الاتصال: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (adId: string) => {
    if (!accountId || !confirm('هل تريد حذف هذا الإعلان؟')) return;
    try {
      const res = await authFetch(`${API}/accounts/${accountId}/ads/${adId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setAds(prev => prev.filter(a => a.id !== adId));
      }
    } catch (e) {
      console.error('[AdLibrary] delete error:', e);
    }
  };

  const handleToggle = async (ad: Ad) => {
    if (!accountId) return;
    try {
      const res = await authFetch(`${API}/accounts/${accountId}/ads/${ad.id}/toggle`, { method: 'PATCH' });
      const data = await res.json();
      if (data.success) {
        setAds(prev => prev.map(a => a.id === ad.id ? { ...a, is_active: data.is_active } : a));
      }
    } catch (e) {
      console.error('[AdLibrary] toggle error:', e);
    }
  };

  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">يجب اختيار حساب واتساب نشط لعرض مكتبة الإعلانات.</p>
        </div>
      </div>
    );
  }

  const filtered = ads.filter(ad =>
    ad.name.toLowerCase().includes(search.toLowerCase()) ||
    ad.content.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">مكتبة الإعلانات</h1>
          <p className="text-[var(--text-secondary)] mt-1">إدارة نصوص الإعلانات والرسائل الجاهزة</p>
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              className="input pr-9"
              placeholder="بحث عن إعلان..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Button onClick={openCreate} className="flex-shrink-0">
            <Plus className="w-4 h-4" />
            <span>إضافة إعلان</span>
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-primary)]" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
            <Star className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
            <h3 className="text-lg font-bold text-[var(--text-primary)]">لا توجد إعلانات بعد</h3>
            <p className="text-sm text-[var(--text-secondary)] mt-2">ابدأ بإنشاء أول إعلان من المكتبة</p>
            <Button className="mt-4" onClick={openCreate}>
              <Plus className="w-4 h-4" />
              إضافة إعلان
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children">
          {filtered.map(ad => (
            <Card key={ad.id} className={cn('card flex flex-col transition-all', !ad.is_active && 'opacity-70 grayscale')}>
              <CardContent className="p-5 flex-1 flex flex-col">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="font-bold text-[var(--text-primary)] text-lg line-clamp-1">{ad.name}</h3>
                  <Badge
                    variant="outline"
                    className={cn('border-0 cursor-pointer', ad.is_active ? 'bg-green-500/10 text-green-500' : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]')}
                    onClick={() => handleToggle(ad)}
                  >
                    {ad.is_active ? 'نشط' : 'معطل'}
                  </Badge>
                </div>

                <div className="bg-[var(--bg-elevated)] p-3 rounded-lg border border-[var(--border-default)] mb-4 flex-1">
                  <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap line-clamp-4 font-mono">
                    {ad.content || '(لا يوجد محتوى)'}
                  </p>
                </div>

                <div className="flex items-center justify-between mt-auto pt-4 border-t border-[var(--border-default)]">
                  <div className="flex items-center gap-1 text-[var(--text-muted)] text-sm">
                    <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                    <span>{ad.priority}/10</span>
                    <span className="mx-2">•</span>
                    <span>{ad.use_count} استخدام</span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost" size="icon"
                      className="h-8 w-8 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                      onClick={() => { setSelectedAd(ad); setIsPreviewOpen(true); }}
                    >
                      <Eye className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost" size="icon"
                      className="h-8 w-8 text-[var(--brand-primary)] hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary-light)]"
                      onClick={() => openEdit(ad)}
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost" size="icon"
                      className="h-8 w-8 text-red-500 hover:text-red-500 hover:bg-red-500/10"
                      onClick={() => handleDelete(ad.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit Modal */}
      <Dialog open={isModalOpen} onOpenChange={v => { if (!saving) setIsModalOpen(v); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingAd ? 'تعديل الإعلان' : 'إضافة إعلان جديد'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-5 py-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">اسم الإعلان <span className="text-red-500">*</span></label>
              <input
                className="input"
                placeholder="مثال: رسالة ترحيبية 1"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">محتوى الرسالة</label>
              <textarea
                className="input h-32 font-mono"
                placeholder="اكتب رسالتك هنا..."
                value={form.content}
                onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">الأولوية (1-10)</label>
                <input
                  className="input"
                  type="number"
                  min={1} max={10}
                  value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: Number(e.target.value) }))}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">الوسوم (اختياري)</label>
                <input
                  className="input"
                  placeholder="رمضان، صيف، عروض"
                  value={form.tags}
                  onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                />
              </div>
            </div>
            <div
              className="flex items-center justify-between bg-[var(--bg-elevated)] p-4 rounded-xl border border-[var(--border-default)] cursor-pointer"
              onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
            >
              <div>
                <p className="font-medium text-[var(--text-primary)]">حالة الإعلان</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">تفعيل الإعلان ليظهر في خيارات النشر.</p>
              </div>
              <div className={cn('w-12 h-6 rounded-full relative transition-colors', form.is_active ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-surface)] border border-[var(--border-strong)]')}>
                <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm', form.is_active ? 'right-1' : 'left-1')} />
              </div>
            </div>
            {error && <p className="text-sm text-red-500 bg-red-500/10 p-3 rounded-lg">{error}</p>}
            <Button className="w-full mt-2" onClick={handleSave} disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 animate-spin ml-2" />جارٍ الحفظ...</> : 'حفظ الإعلان'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview Modal */}
      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="sm:max-w-sm bg-[#efeae2] border-0 p-0 overflow-hidden rounded-3xl">
          <div className="bg-[#00a884] h-16 flex items-center px-4 shadow-sm text-white sticky top-0 z-10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center">
                <Smartphone className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="font-bold">معاينة الرسالة</h3>
                <p className="text-xs opacity-80">WhatsApp</p>
              </div>
            </div>
          </div>
          <div className="p-4 bg-repeat min-h-[300px] flex flex-col justify-end pb-12 relative z-0" style={{ backgroundColor: '#dfe7ec' }}>
            {selectedAd && (
              <div className="bg-white p-3 rounded-2xl rounded-tr-none shadow-sm max-w-[85%] self-end relative mb-2">
                <p className="text-[#111b21] text-[15px] leading-relaxed whitespace-pre-wrap dir-rtl">{selectedAd.content}</p>
                <span className="text-[11px] text-gray-400 float-left mt-2 ml-1">
                  {new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            )}
          </div>
          <Button variant="secondary" className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-lg" onClick={() => setIsPreviewOpen(false)}>
            إغلاق المعاينة
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
