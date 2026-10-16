// site.mjs — browser-control-plane-core: per-process site bootstrap.
//
// Mỗi site plugin (actions-<site>/registry.mjs) GỌI configureSite() ở đầu module,
// trước khi bất kỳ action nào chạy. Mọi module core (primitives, evidence, runner)
// đọc site() LAZY — tức là chỉ bên trong function body, không ở top-level — nên
// thứ tự import không quan trọng, miễn là configureSite() đã chạy trước khi
// action đầu tiên thực thi. Trong luồng chuẩn, proto/run-action.mjs (core runner)
// luôn import registry TRƯỚC khi import primitives/evidence, nên điều này tự đúng.
//
// Env var contract được giữ nguyên 100%: siteEnv('DEBUG') === process.env[`${prefix}_DEBUG`]
// (vd prefix 'SUNO_CP' → SUNO_CP_DEBUG). Không đổi tên env var nào so với bản cũ.

let _site = null;

export function configureSite({ prefix, cdpUrl, deployDir, evidenceDir, preferUrl }) {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('configureSite: prefix bắt buộc (vd "SUNO_CP")');
  }
  _site = {
    prefix,
    cdpUrl: cdpUrl || '',
    deployDir: deployDir || '',
    evidenceDir: evidenceDir || '',
    preferUrl: preferUrl || '',
  };
}

export function site() {
  if (!_site) {
    throw new Error(
      'browser-control-plane-core: configureSite() chưa được gọi. ' +
      'Registry của site phải gọi configureSite() ở đầu module.'
    );
  }
  return _site;
}

// Đọc env var theo prefix của site đang chạy.
export function siteEnv(name) {
  return process.env[`${site().prefix}_${name}`];
}
