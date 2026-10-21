// تصدير CSV متوافق مع Excel العربي (BOM + فاصلة)

// توليد محتوى CSV كنص فقط (بلا DOM) — معزول ليكون قابلاً لاختبار الوحدة (M5).
// يشمل: BOM لتوافق Excel العربي + تحييد حقن الصيغ + اقتباس الحقول ذات الفواصل/الاقتباس/الأسطر.
export function buildCsvContent(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const esc = (v: string | number | null | undefined) => {
    let s: string;
    if (v == null) s = "";
    else if (typeof v === "object") {
      try { s = JSON.stringify(v) ?? ""; } catch { s = ""; }
    } else s = String(v);
    // حماية من حقن الصيغ في جداول البيانات (CWE-1236 / OWASP CSV Injection):
    // تطبيقات مثل Excel/Sheets/LibreOffice قد تتجاهل المسافات والأسطر والتبويب البادئة
    // ثم تفسّر أول محرف فعّال كصيغة. لذلك نفحص القيمة الأصلية وأيضًا بعد تشذيب أي مسافات
    // بادئة (تشمل space/newline/tab/CR/FF/VT وغيرها عبر \s)، فنحيّد ما يبدأ بـ:
    //   = @ tab CR  أو  +/- غير الرقمية — مع الإبقاء على الأرقام (-5، +3.2، +966…) كما هي.
    const lead = s.replace(/^\s+/, "");
    if (
      /^[=@\t\r]/.test(s) ||
      /^[=@]/.test(lead) ||
      (/^[+\-]/.test(lead) && !/^[+\-]?(\d|\.\d)/.test(lead))
    ) {
      s = "'" + s;
    }
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))];
  return "﻿" + lines.join("\n");
}

// يعيد true عند نجاح إطلاق التنزيل و false عند الفشل (بلا رمي استثناء غير مُلتقَط) — يتيح
// للمستدعي عرض تغذية نجاح/فشل (CSV-2) بدل «ضغطة بلا أثر». الفشل يُسجَّل في console.
export function downloadCSV(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
): boolean {
  try {
    const blob = new Blob([buildCsvContent(headers, rows)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    // M5: يجب إلحاق الرابط بالـDOM قبل click() ثم إزالته. النقر على عنصر <a> منفصل عن الشجرة
    // لا يُطلق التنزيل في بعض المتصفحات (Firefox خصوصًا) ⇒ ضغطة بلا ملف رغم وجود صفوف —
    // وهو السبب البرمجي المرجّح لعطل تصدير مركز الإجراءات. النمط الملحق موثوق عبر المتصفحات.
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // (CSV-3) نؤجّل إبطال الـURL tick واحد حتى يكون التنزيل قد بدأ فعليًا قبل تحرير الـBlob.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch (e) {
    if (typeof console !== "undefined") console.error("[downloadCSV] failed:", e);
    return false;
  }
}
