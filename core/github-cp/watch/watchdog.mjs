// watchdog.mjs — GitHub Control Plane (copy + chuyển web từ ChatGPT sang GitHub)
// Contract giữ nguyên: checkSession(page) -> { loggedIn, cloudflare, detail }
export async function checkSession(page) {
  try {
    const snapshot = await page.evaluate(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        );
      };

      const label = (element) =>
        [
          element.innerText || '',
          element.getAttribute('aria-label') || '',
          element.getAttribute('title') || '',
          element.getAttribute('alt') || '',
          element.value || '',
        ]
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

      const controls = Array.from(
        document.querySelectorAll(
          'button, a, [role="button"], input[type="button"], input[type="submit"]',
        ),
      ).filter(visible);

      const labels = controls.map(label);
      const loginButtons = labels.filter((text) =>
        /\b(?:log\s*in|sign\s*in)\b/i.test(text),
      ).length;

      const avatarCount = Array.from(
        document.querySelectorAll(
          '[data-testid*="avatar" i], [aria-label*="avatar" i], ' +
            '[aria-label*="account" i], [aria-label*="profile" i], ' +
            'img[alt*="avatar" i], img[alt*="profile" i], ' +
            '[class*="avatar" i]',
        ),
      ).filter(visible).length;

      const menuText = labels.filter((text) =>
        /\b(?:(?:user|account|profile)\s*menu|my\s*(?:account|profile)|log\s*out|sign\s*out)\b/i.test(
          text,
        ),
      );
      const logoutText = Array.from(
        document.querySelectorAll('[role="menuitem"]'),
      )
        .filter(visible)
        .map(label)
        .filter((text) => /\b(?:log\s*out|sign\s*out)\b/i.test(text));

      // Dấu hiệu app GitHub đã vào phiên: header có nút "New" + avatar user
      // (chỉ hiện khi đã đăng nhập — trang public ẩn danh không có).
      const appSignalCount = Array.from(
        document.querySelectorAll(
          'a[href="/new"], header img.avatar-user, [data-testid*="create" i]',
        ),
      ).filter(visible).length;

      return {
        title: document.title || '',
        innerText: document.body?.innerText || '',
        loginButtons,
        avatarCount,
        menuText,
        logoutText,
        appSignalCount,
      };
    });

    const url = String(page.url());
    const cloudflare =
      /verify you are human|just a moment|cf-challenge|attention required|cf-|__cf/i.test(
        `${snapshot.title}\n${snapshot.innerText}\n${url}`,
      );

    const userSigns =
      snapshot.avatarCount > 0 ||
      snapshot.menuText.length > 0 ||
      snapshot.logoutText.length > 0;

    const hostname = new URL(url).hostname.toLowerCase();
    const isGitHub =
      hostname === 'github.com' || hostname.endsWith('.github.com');

    let loggedIn = userSigns || (isGitHub && snapshot.appSignalCount > 0);
    if (snapshot.loginButtons > 0 && !userSigns) loggedIn = false;
    if (cloudflare) loggedIn = false;

    const detail = JSON.stringify({
      url,
      title: snapshot.title,
      loginButtons: snapshot.loginButtons,
      avatarCount: snapshot.avatarCount,
      menuText: snapshot.menuText,
      logoutText: snapshot.logoutText,
      appSignalCount: snapshot.appSignalCount,
      isGitHub,
      userSigns,
    });

    return { loggedIn, cloudflare, detail };
  } catch (error) {
    let message = 'Unknown error';
    try {
      message = error instanceof Error ? error.message : String(error);
    } catch {
      // Preserve the non-throwing contract.
    }
    return {
      loggedIn: false,
      cloudflare: false,
      detail: `checkSession error: ${message}`,
    };
  }
}
