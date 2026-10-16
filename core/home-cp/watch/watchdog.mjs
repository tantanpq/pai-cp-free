// watchdog.mjs — HOME Control Plane session watchdog (STUB — vòng này KHÔNG cài watchdog task nào trên HOME).
// home-cp chạy với gate 'none' nên module này không bao giờ được gọi trong luồng chuẩn.
// Giữ lại để đủ contract runCli({watchdogUrl}) và cho tương lai (vd gate health-check box).
export async function checkSession(/* page */) {
  return { ok: true, note: 'home-cp has no browser session gate' };
}
