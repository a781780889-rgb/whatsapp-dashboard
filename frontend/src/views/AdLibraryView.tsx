import React, { useState } from 'react';
import { Search, Plus, Edit2, Trash2, Eye, Star, Smartphone } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/utils/cn';

export default function AdLibraryView({ accountId }: { accountId: string | null }) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [selectedAd, setSelectedAd] = useState<any>(null);

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

  const mockAds = [
    { id: 1, name: 'إعلان الصيف الرئيسي', content: 'مرحباً! 👋\nعروض الصيف بدأت الآن. خصومات تصل إلى 50% على جميع المنتجات.\nلا تفوت الفرصة!', active: true, priority: 5, uses: 14 },
    { id: 2, name: 'رسالة ترحيبية للمجموعات', content: 'أهلاً بكم في مجموعة عملائنا المميزين.\nهنا نشارككم أحدث العروض والأخبار حصرياً.', active: true, priority: 3, uses: 56 },
    { id: 3, name: 'إعلان قديم - رمضان', content: 'رمضان كريم!\nنقدم لكم تشكيلة رمضان الجديدة بأسعار خاصة.', active: false, priority: 1, uses: 4 },
  ];

  const handlePreview = (ad: any) => {
    setSelectedAd(ad);
    setIsPreviewOpen(true);
  };

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
            <input className="input pr-9" placeholder="بحث عن إعلان..." />
          </div>
          <Button onClick={() => setIsModalOpen(true)} className="flex-shrink-0">
            <Plus className="w-4 h-4" />
            <span>إضافة إعلان</span>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children">
        {mockAds.map(ad => (
          <Card key={ad.id} className={cn("card flex flex-col transition-all", !ad.active && "opacity-70 grayscale")}>
            <CardContent className="p-5 flex-1 flex flex-col">
              <div className="flex justify-between items-start mb-3">
                <h3 className="font-bold text-[var(--text-primary)] text-lg">{ad.name}</h3>
                <Badge variant="outline" className={cn("border-0", ad.active ? "bg-green-500/10 text-green-500" : "bg-[var(--bg-elevated)] text-[var(--text-muted)]")}>
                  {ad.active ? 'نشط' : 'معطل'}
                </Badge>
              </div>

              <div className="bg-[var(--bg-elevated)] p-3 rounded-lg border border-[var(--border-default)] mb-4 flex-1">
                <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap line-clamp-4 font-mono">{ad.content}</p>
              </div>

              <div className="flex items-center justify-between mt-auto pt-4 border-t border-[var(--border-default)]">
                <div className="flex items-center gap-1 text-[var(--text-muted)] text-sm">
                  <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                  <span>{ad.priority}/5</span>
                  <span className="mx-2">•</span>
                  <span>{ad.uses} استخدام</span>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]" onClick={() => handlePreview(ad)}>
                    <Eye className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-[var(--brand-primary)] hover:text-[var(--brand-primary)] hover:bg-[var(--brand-primary-light)]">
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-500 hover:bg-red-500/10">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create Modal */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>إضافة إعلان جديد</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-5 py-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">اسم الإعلان (للإدارة الداخلية)</label>
              <input className="input" placeholder="مثال: رسالة ترحيبية 1" />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">محتوى الرسالة</label>
              <textarea className="input h-32 font-mono" placeholder="اكتب رسالتك هنا..." />
            </div>
            <div className="flex items-center justify-between bg-[var(--bg-elevated)] p-4 rounded-xl border border-[var(--border-default)]">
              <div>
                <p className="font-medium text-[var(--text-primary)]">حالة الإعلان</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">تفعيل الإعلان ليظهر في خيارات النشر.</p>
              </div>
              <div className="w-12 h-6 bg-[var(--brand-primary)] rounded-full relative cursor-pointer">
                <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full" />
              </div>
            </div>
            <Button className="w-full mt-2" onClick={() => setIsModalOpen(false)}>حفظ الإعلان</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview Modal - WhatsApp Style */}
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
          
          <div className="p-4 bg-[url('https://web.whatsapp.com/img/bg-chat-tile-light_04fcacde539c58cca6745483d4858c52.png')] bg-repeat min-h-[300px] flex flex-col justify-end pb-12 relative z-0">
            {selectedAd && (
              <div className="bg-white p-3 rounded-2xl rounded-tr-none shadow-sm max-w-[85%] self-end relative mb-2">
                <p className="text-[#111b21] text-[15px] leading-relaxed whitespace-pre-wrap dir-rtl">{selectedAd.content}</p>
                <span className="text-[11px] text-gray-400 float-left mt-2 ml-1">10:42 AM</span>
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
