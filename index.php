<?php
declare(strict_types=1);
$salsarBootstrap = dirname(__DIR__) . '/salsar-private/bootstrap.php';
if (!is_file($salsarBootstrap)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit('مجلد سلسار الخاص غير موجود خارج جذر الويب. راجع دليل النقل قبل المتابعة.');
}
require $salsarBootstrap;
salsar_session_start();
$config = salsar_config();
$user = $_SESSION['salsar_user'] ?? null;
if (is_array($user) && !empty($user['email'])) {
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    readfile(__DIR__ . '/app-template.html');
    exit;
}
?><!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>سلسار | SalSar — تسجيل الدخول</title>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f5f7;color:#07111f;font-family:Calibri,Arial,sans-serif}.card{width:min(92vw,420px);background:#fff;border:1px solid #d9dee7;border-radius:22px;padding:34px;box-shadow:0 18px 55px #07111f18;text-align:center}.brand{background:#07111f;color:#fff;border-radius:16px;padding:22px;margin-bottom:24px}.brand b{display:block;font-size:25px}.brand span{display:block;margin-top:5px}.hint{color:#526070;line-height:1.7;margin:0 0 22px}.error{display:none;color:#991b1b;background:#fee2e2;border-radius:10px;padding:10px;margin-top:16px}.loading{display:none;margin-top:14px;color:#243b7b}
  </style>
</head>
<body>
  <main class="card">
    <div class="brand"><b>سلسار | SalSar</b><span>سجل المركبات<br><span lang="en">Vehicles Log</span></span></div>
    <p class="hint">الدخول مخصص لمسؤول المركبات المعتمد في المنشأة.</p>
    <div id="g_id_onload" data-client_id="<?= htmlspecialchars((string)$config['google_client_id'], ENT_QUOTES, 'UTF-8') ?>" data-callback="onGoogleCredential" data-auto_prompt="false"></div>
    <div class="g_id_signin" data-type="standard" data-shape="pill" data-theme="outline" data-text="signin_with" data-size="large" data-logo_alignment="left"></div>
    <div id="loading" class="loading">جارٍ التحقق من الحساب…</div>
    <div id="error" class="error"></div>
  </main>
  <script>
    async function onGoogleCredential(response){
      const loading=document.getElementById('loading'),error=document.getElementById('error');
      loading.style.display='block';error.style.display='none';
      try{
        const result=await fetch('auth.php',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({credential:response.credential})});
        const data=await result.json();
        if(!result.ok||!data.ok)throw new Error(data.error||'تعذر تسجيل الدخول');
        location.replace('./');
      }catch(err){error.textContent=err.message||'تعذر تسجيل الدخول';error.style.display='block';loading.style.display='none'}
    }
  </script>
</body>
</html>
