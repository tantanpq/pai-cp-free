// watchdog.mjs — REA Control Plane
// Contract: checkSession(page) -> { loggedIn, cloudflare, detail }.
// Khác các plane service: rea-cp là map tool, quét được cả trang public —
// login là thông tin (để biết target nào cần session), KHÔNG phải điều kiện bắt buộc.
// Gate duy nhất: không có Cloudflare challenge.
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
        ].join(' ').replace(/\s+/g, ' ').trim();
      const controls = Array.from(
        document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'),
      ).filter(visible);
      const labels = controls.map(label);
      const loginButtons = labels.filter((text) => /\b(?:log\s*in|sign\s*in)\b/i.test(text)).length;
      const avatarCount = Array.from(
        document.querySelectorAll(
          '[data-testid*="avatar" i], [aria-label*="avatar" i], [aria-label*="account" i], ' +
          '[aria-label*="profile" i], img[alt*="avatar" i], img[alt*="profile" i], [class*="avatar" i]',
        ),
      ).filter(visible).length;
      const logoutCount = labels.filter((text) => /\b(?:log\s*out|sign\s*out)\b/i.test(text)).length;
      return {
        title: document.title || '',
        innerText: (document.body?.innerText || '').slice(0, 4000),
        loginButtons, avatarCount, logoutCount,
      };
    });
    const url = String(page.url());
    const cloudflare = /verify you are human|just a moment|cf-challenge|attention required|cf-|__cf/i.test(
      `${snapshot.title}\n${snapshot.innerText}\n${url}`,
    );
    const loggedIn = snapshot.avatarCount > 0 || snapshot.logoutCount > 0 || (snapshot.loginButtons === 0 && snapshot.innerText.length > 100);
    const detail = JSON.stringify({ url, title: snapshot.title, loginButtons: snapshot.loginButtons, avatarCount: snapshot.avatarCount, logoutCount: snapshot.logoutCount, cloudflare });
    return { loggedIn, cloudflare, detail };
  } catch (error) {
    return { loggedIn: false, cloudflare: false, detail: `checkSession error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
