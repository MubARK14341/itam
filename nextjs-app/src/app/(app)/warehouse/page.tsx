import { redirect } from "next/navigation";

// أُزيل التكرار: «مهام المستودع» صارت منظورًا تشغيليًا داخل الطلبات، لا صفحة مستقلة.
// نُبقي المسار لتفادي كسر أي رابط/إشارة مرجعية قديمة، ونحوّله فورًا (redirect خادمي، بلا وميض).
// المصدر والحارس والمنطق كله في /requests?view=warehouse — لم يُكرَّر شيء هنا.
export default function WarehouseRedirect() {
  redirect("/requests?view=warehouse");
}
