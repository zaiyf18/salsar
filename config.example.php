<?php
/**
 * سلسار — نموذج ملف الإعدادات
 * =========================================================================
 * انسخ هذا الملف باسم config.php في المجلد نفسه (salsar-private/) واملأ القيم.
 * يقرؤه bootstrap.php عبر salsar_config()، ويجب أن يُرجع مصفوفة.
 *
 * ⚠ config.php لا يُرفع إلى المستودع أبدًا — وهو مستثنى في .gitignore.
 *   إن رُفع بالخطأ ولو مرة، فلا يكفي حذفه: بدّل SALSAR_API_TOKEN فورًا من
 *   Script Properties في مشروع Apps Script، لأن تاريخ git يبقى.
 * =========================================================================
 */
return [
    // رابط نشر تطبيق Apps Script (ينتهي بـ /exec)
    'apps_script_url'   => 'https://script.google.com/macros/s/XXXXXXXXXXXX/exec',

    // نفس قيمة SALSAR_API_TOKEN في Script Properties داخل مشروع Apps Script.
    // ولّده عشوائيًا بطول 32 محرفًا فأكثر، ولا يظهر في أي لقطة شاشة.
    'apps_script_token' => 'ضع-الرمز-هنا',

    // معرّف عميل Google لتسجيل الدخول. علنيّ بطبيعته ويظهر في صفحة الدخول.
    'google_client_id'  => 'XXXXXXXXXXXX.apps.googleusercontent.com',

    // نطاق Google Workspace المسموح (يُقارَن بادعاء hd في رمز الدخول)
    'allowed_domain'    => 'example.com',

    // البُرد المصرّح لها بالدخول — قائمة، ويجب أن يكون البريد ضمنها
    // إضافةً إلى مطابقة النطاق أعلاه. الشرطان معًا لا أحدهما.
    'allowed_emails'    => [
        'you@example.com',
    ],
];
