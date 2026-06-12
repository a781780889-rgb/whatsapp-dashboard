import React, { useState } from 'react';
import { Calendar, Plus, Smartphone, Clock, Users, Play, Pause, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/utils/cn';

export default function ScheduleDashboardView({ accountId }: { accountId: string | null }) {
  const [isModalOpen, setIsModalOpen] = useState(false);

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

  const mockSchedules = [
    { id: 1, name: 'النشرة الصباحية', ads: 'إعلان الصيف', groups: 5, times: ['09:00', '10:00'], days: ['الأحد', 'الثلاثاء', 'الخميس'], status: 'نشط' },
    { id: 2, name: 'عروض المساء', ads: 'إعلان خصم 50%', groups: 2, times: ['20:00'], days: ['يومياً'], status: 'موقوف' },
  ];

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">النشر المجدول</h1>
          <p className="text-[var(--text-secondary)] mt-1">جدولة نشر الإعلانات آلياً حسب الأيام والأوقات</p>
        </div>
        <Button onClick={() => setIsModalOpen(true)}>
          <Plus className="w-4 h-4" />
          <span>جدولة جديدة</span>
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'إجمالي الجداول', value: '2', color: 'text-blue-500' },
          { label: 'جداول نشطة', value: '1', color: 'text-green-500' },
          { label: 'جداول موقوفة', value: '1', color: 'text-yellow-500' },
        ].map((stat, i) => (
          <Card key={i} className="card">
            <CardContent className="p-4 flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--text-secondary)]">{stat.label}</span>
              <span className={cn("text-2xl font-bold", stat.color)}>{stat.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="card flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-auto">
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
              {mockSchedules.map(sch => (
                <TableRow key={sch.id} className="border-[var(--border-default)] group">
                  <TableCell className="font-medium text-[var(--text-primary)] py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--brand-primary)] border border-[var(--border-default)]">
                        <Calendar className="w-4 h-4" />
                      </div>
                      {sch.name}
                    </div>
                  </TableCell>
                  <TableCell className="text-[var(--text-secondary)] text-sm">{sch.ads}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-[var(--text-secondary)] text-sm">
                      <Users className="w-4 h-4" />
                      {sch.groups}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {sch.times.map(t => (
                        <span key={t} className="px-2 py-0.5 bg-[var(--bg-elevated)] rounded border border-[var(--border-default)] text-xs dir-ltr font-mono text-[var(--text-primary)]">{t}</span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-[var(--text-secondary)] text-sm">{sch.days.join(', ')}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(
                      "border-0 font-medium",
                      sch.status === 'نشط' ? "bg-green-500/10 text-green-500" : "bg-yellow-500/10 text-yellow-500"
                    )}>
                      {sch.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                      {sch.status === 'موقوف' && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-green-500 hover:text-green-500 hover:bg-green-500/10"><Play className="w-4 h-4" /></Button>
                      )}
                      {sch.status === 'نشط' && (
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

      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>جدولة نشر جديدة</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-6 py-4 max-h-[70vh] overflow-y-auto pr-2">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">اسم الجدولة</label>
              <input className="input" placeholder="مثال: النشرة الصباحية اليومية" />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">اختيار الإعلان</label>
                <select className="input">
                  <option>إعلان الصيف الرئيسي</option>
                  <option>رسالة ترحيبية للمجموعات</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">المجموعات المستهدفة</label>
                <select className="input">
                  <option>كل المجموعات (15)</option>
                  <option>مجموعات العملاء الجدد (5)</option>
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">أيام النشر</label>
              <div className="flex flex-wrap gap-2">
                {['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'].map((day, i) => (
                  <button key={day} className={cn("px-4 py-2 rounded-lg border text-sm transition-colors", i === 0 || i === 2 ? "bg-[var(--brand-primary-light)] border-[var(--brand-primary)] text-[var(--brand-primary)]" : "bg-[var(--bg-elevated)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]")}>
                    {day}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">أوقات النشر</label>
              <div className="flex items-center gap-2">
                <input type="time" className="input w-32 dir-ltr text-center" defaultValue="09:00" />
                <Button variant="outline" className="px-3" title="إضافة وقت">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                <div className="px-3 py-1.5 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-md text-sm font-mono dir-ltr flex items-center gap-2">
                  09:00 <Trash2 className="w-3 h-3 text-red-500 cursor-pointer" />
                </div>
                <div className="px-3 py-1.5 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-md text-sm font-mono dir-ltr flex items-center gap-2">
                  14:30 <Trash2 className="w-3 h-3 text-red-500 cursor-pointer" />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">الحد الأقصى للرسائل يومياً</label>
              <input className="input" type="number" defaultValue={500} />
              <p className="text-xs text-[var(--text-muted)]">لحماية الحساب من الحظر.</p>
            </div>

            {/* ━━ خيارات الإرسال الإضافية ━━ */}
            <div className="flex flex-col gap-3">
              <h4 className="text-sm font-semibold text-[var(--text-primary)] border-b border-[var(--border-default)] pb-2">خيارات الإرسال</h4>
              
              {/* إرسال للأعضاء خاص */}
              <label className="flex items-center justify-between p-3 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)] cursor-pointer hover:border-[var(--brand-primary)] transition-colors">
                <div>
                  <p className="font-medium text-[var(--text-primary)] text-sm">إرسال للأعضاء (خاص)</p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">بالإضافة للمجموعة، يُرسل رسالة خاصة لكل عضو</p>
                </div>
                <input type="checkbox" id="send_to_members_sched" className="w-4 h-4 rounded border-[var(--border-strong)] text-[var(--brand-primary)]" />
              </label>

              {/* استبعاد المشرفين */}
              <label className="flex items-center justify-between p-3 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)] cursor-pointer hover:border-orange-400 transition-colors">
                <div>
                  <p className="font-medium text-[var(--text-primary)] text-sm">استبعاد المشرفين</p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">لا يُرسل للمشرفين عند الإرسال الخاص للأعضاء</p>
                </div>
                <input type="checkbox" id="exclude_admins_sched" defaultChecked className="w-4 h-4 rounded border-[var(--border-strong)] text-orange-500" />
              </label>
            </div>
            
            <div className="pt-4 border-t border-[var(--border-default)] flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsModalOpen(false)}>إلغاء</Button>
              <Button onClick={() => setIsModalOpen(false)}>حفظ الجدولة</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
