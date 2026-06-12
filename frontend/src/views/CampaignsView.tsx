import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Play, Pause, Trash2, Plus, Megaphone, Smartphone, Check } from 'lucide-react';
import { cn } from '@/utils/cn';

export default function CampaignsView({ accountId }: { accountId: string | null }) {
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [step, setStep] = useState(1);

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

  const mockCampaigns = [
    { id: 1, name: 'عروض رمضان', target: 5000, sent: 3500, status: 'نشطة', progress: 70 },
    { id: 2, name: 'تحديث السياسة', target: 12000, sent: 12000, status: 'مكتملة', progress: 100 },
    { id: 3, name: 'منتجات جديدة', target: 2000, sent: 500, status: 'متوقفة', progress: 25 },
  ];

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">الحملات</h1>
          <p className="text-[var(--text-secondary)] mt-1">إدارة حملات الإرسال الجماعي</p>
        </div>
        <Button onClick={() => setIsWizardOpen(true)}>
          <Plus className="w-4 h-4" />
          <span>حملة جديدة</span>
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'إجمالي', value: '12', color: 'text-blue-500' },
          { label: 'نشطة', value: '3', color: 'text-green-500' },
          { label: 'متوقفة', value: '2', color: 'text-yellow-500' },
          { label: 'مكتملة', value: '7', color: 'text-gray-500' },
        ].map((stat, i) => (
          <Card key={i} className="card">
            <CardContent className="p-4 flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--text-secondary)]">{stat.label}</span>
              <span className={cn("text-xl font-bold", stat.color)}>{stat.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="card flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-auto">
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
              {mockCampaigns.map(camp => (
                <TableRow key={camp.id} className="border-[var(--border-default)] group">
                  <TableCell className="font-medium text-[var(--text-primary)] py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--brand-primary)]">
                        <Megaphone className="w-4 h-4" />
                      </div>
                      {camp.name}
                    </div>
                  </TableCell>
                  <TableCell className="text-[var(--text-secondary)]">{camp.target.toLocaleString()}</TableCell>
                  <TableCell className="text-[var(--text-secondary)]">{camp.sent.toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Progress value={camp.progress} className="w-24" />
                      <span className="text-xs text-[var(--text-muted)] w-8">{camp.progress}%</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(
                      "border-0 font-medium",
                      camp.status === 'نشطة' ? "bg-green-500/10 text-green-500" :
                      camp.status === 'متوقفة' ? "bg-yellow-500/10 text-yellow-500" :
                      "bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                    )}>
                      {camp.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                      {camp.status !== 'نشطة' && camp.status !== 'مكتملة' && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-green-500 hover:text-green-500 hover:bg-green-500/10"><Play className="w-4 h-4" /></Button>
                      )}
                      {camp.status === 'نشطة' && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-yellow-500 hover:text-yellow-500 hover:bg-yellow-500/10"><Pause className="w-4 h-4" /></Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-500 hover:bg-red-500/10"><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Dialog open={isWizardOpen} onOpenChange={setIsWizardOpen}>
        <DialogContent className="sm:max-w-2xl min-h-[500px] flex flex-col">
          <DialogHeader>
            <DialogTitle>حملة جديدة</DialogTitle>
          </DialogHeader>
          
          <div className="flex items-center justify-center gap-2 py-4">
            {[1,2,3,4,5].map(s => (
              <React.Fragment key={s}>
                <div className={cn("w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors", step === s ? "bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]" : step > s ? "bg-[var(--brand-primary-light)] text-[var(--brand-primary)]" : "bg-[var(--bg-elevated)] text-[var(--text-muted)]")}>
                  {step > s ? <Check className="w-4 h-4" /> : s}
                </div>
                {s < 5 && <div className={cn("w-12 h-1 rounded-full transition-colors", step > s ? "bg-[var(--brand-primary-light)]" : "bg-[var(--bg-elevated)]")} />}
              </React.Fragment>
            ))}
          </div>

          <div className="flex-1 overflow-auto py-4">
            {step === 1 && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium">اسم الحملة</label>
                  <input className="input" placeholder="أدخل اسماً مميزاً للحملة..." />
                </div>
                <div className="flex flex-col gap-2 mt-4">
                  <label className="text-sm font-medium">اختر الإعلان من المكتبة</label>
                  <div className="grid grid-cols-2 gap-3">
                    {[1,2,3,4].map(i => (
                      <div key={i} className="border border-[var(--border-default)] rounded-xl p-4 cursor-pointer hover:border-[var(--brand-primary)] transition-colors">
                        <div className="font-bold text-[var(--text-primary)]">إعلان الصيف {i}</div>
                        <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">هذا نص تجريبي لمحتوى الإعلان يظهر هنا ليعطي فكرة عن شكله.</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {step === 2 && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <h3 className="font-bold text-[var(--text-primary)]">اختيار المجموعات المستهدفة</h3>
                <div className="border border-[var(--border-default)] rounded-xl overflow-hidden">
                  {[1,2,3,4,5].map(i => (
                    <label key={i} className="flex items-center gap-3 p-3 border-b border-[var(--border-default)] last:border-0 hover:bg-[var(--bg-elevated)] cursor-pointer">
                      <input type="checkbox" className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]" />
                      <div className="flex-1">
                        <p className="font-medium text-[var(--text-primary)]">مجموعة العملاء النشطين {i}</p>
                        <p className="text-xs text-[var(--text-muted)]">240 عضو</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {step === 3 && (
              <div className="flex flex-col gap-6 animate-fade-in">
                <h3 className="font-bold text-[var(--text-primary)]">قواعد الاستبعاد</h3>
                <div className="flex flex-col gap-4">
                  <label className="flex items-center justify-between p-4 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)] cursor-pointer">
                    <div>
                      <p className="font-medium text-[var(--text-primary)]">استبعاد المشرفين (Admins)</p>
                      <p className="text-xs text-[var(--text-muted)] mt-1">لا ترسل رسائل لمشرفي المجموعات.</p>
                    </div>
                    <div className="w-10 h-6 bg-[var(--brand-primary)] rounded-full relative">
                      <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full" />
                    </div>
                  </label>
                  <label className="flex items-center justify-between p-4 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)] cursor-pointer">
                    <div>
                      <p className="font-medium text-[var(--text-primary)]">منع التكرار (Duplicates)</p>
                      <p className="text-xs text-[var(--text-muted)] mt-1">إرسال رسالة واحدة فقط للرقم حتى لو تواجد في عدة مجموعات.</p>
                    </div>
                    <div className="w-10 h-6 bg-[var(--brand-primary)] rounded-full relative">
                      <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full" />
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
                    <label className="text-sm font-medium">الفاصل الزمني (ثواني)</label>
                    <select className="input cursor-pointer">
                      <option>10 - 20 ثانية (آمن)</option>
                      <option>20 - 40 ثانية (أكثر أماناً)</option>
                      <option>5 - 10 ثواني (سريع وخطر)</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">الحد الأقصى اليومي</label>
                    <input className="input" type="number" defaultValue={500} />
                  </div>
                </div>
              </div>
            )}
            {step === 5 && (
              <div className="flex flex-col gap-6 animate-fade-in">
                <div className="text-center">
                  <div className="w-16 h-16 bg-green-500/10 text-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Check className="w-8 h-8" />
                  </div>
                  <h3 className="text-xl font-bold text-[var(--text-primary)]">جاهز للإطلاق</h3>
                  <p className="text-[var(--text-secondary)] mt-2">فيما يلي ملخص مسبق للأرقام المستهدفة.</p>
                </div>
                <div className="bg-[var(--bg-elevated)] p-4 rounded-xl border border-[var(--border-default)] flex flex-col gap-2">
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">إجمالي الأرقام في المجموعات:</span>
                    <span className="font-bold text-[var(--text-primary)]">1,240</span>
                  </div>
                  <div className="flex justify-between text-yellow-500">
                    <span>مستبعد (تكرار / مشرفين):</span>
                    <span className="font-bold">-140</span>
                  </div>
                  <div className="w-full h-px bg-[var(--border-default)] my-2" />
                  <div className="flex justify-between text-lg">
                    <span className="text-[var(--text-primary)]">الصافي المستهدف:</span>
                    <span className="font-bold text-green-500">1,100</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-between mt-auto pt-4 border-t border-[var(--border-default)]">
            <Button variant="outline" onClick={() => step > 1 ? setStep(step - 1) : setIsWizardOpen(false)}>
              {step > 1 ? 'السابق' : 'إلغاء'}
            </Button>
            <Button onClick={() => step < 5 ? setStep(step + 1) : setIsWizardOpen(false)}>
              {step < 5 ? 'التالي' : 'إطلاق الحملة'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
