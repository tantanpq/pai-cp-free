// B1: bootstrap site cho browser-control-plane-core (KHÔNG đổi behavior).
import { configureSite } from '../../browser-control-plane-core/site.mjs';
import { cdpUrl, deployDir, evidenceDir } from '../config.mjs';
configureSite({ prefix: 'GITHUB_CP', cdpUrl, deployDir, evidenceDir, preferUrl: 'github.com' });

// actions-github/registry.mjs — GitHub Control Plane action registry.
// 4 actions bắt buộc theo GITHUB_CONTROL_PLANE_BUILD.md (Tân duyệt 2026-10-10 23:35).
// Registry chỉ dùng page và primitives do caller cấp (ctx.page, ctx.prim, ctx.ev, ctx.log).
//
// LUẬT CỨNG: không merge, không close/reopen, không xóa issue, không push code,
// không đụng setting repo. Chỉ 4 actions dưới.
//
// LOCATOR (thứ tự fallback: accessibility role → visible text → JS evaluate).
// Selector đã kiểm chứng (2026-10-10):
//   - #new_comment_field (textarea comment classic editor) — vẫn là chuẩn hiện tại,
//     nhiều workflow automation 2026 còn dùng; fallback textarea[id*="comment"]
//     hoặc placeholder "Use Markdown to format your comment".
//   - Nút Comment: button có text chính xác "Comment". Lưu ý: nút Comment bắt đầu
//     ở trạng thái disabled và chỉ enable sau khi draft có nội dung (ref/button
//     state thay đổi) → sau fill PHẢI verify textarea có text và nút enabled
//     mới được bấm.
// Giả định (chưa verify DOM trực tiếp, check ở runtime bằng JS fallback):
//   - Trang tạo issue mới: input#issue_title (name="issue[title]"),
//     textarea#issue_body (name="issue[body]"), nút Create (text "Create").
//   - Discussion comment: comment box cấu trúc tương tự issue (textarea#new_comment_field
//     hoặc textarea có placeholder "Use Markdown to format your comment").
//
// IDEMPOTENCY: run-action.mjs đã check receipt trước khi dispatch (theo
// cmd.idempotency_key top-level) và append receipt sau khi ok. Registry ở đây
// vẫn BẮT BUỘC idempotency_key trong params của 3 action ghi (defense-in-depth):
// thiếu → throw, không chạy.
//
// BÀI HỌC QA (ChatGPT chat.send false-positive): với action ghi, sau khi bấm
// PHẢI verify kết quả thật trong DOM (comment xuất hiện với text của mình,
// issue mới được tạo). Không verify được → throw, không trả ok:true mù.

const ok = (data = {}) => ({ ok: true, data });
const expr = (fn, ...args) => `(${fn.toString()})(...${JSON.stringify(args)})`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GITHUB_BASE = 'https://github.com';

async function evidence(ctx, step, data = {}) {
  try { await ctx.ev?.logStep?.(step, { timestamp: new Date().toISOString(), ...data }); } catch { /* Evidence không chặn action. */ }
}
// Retry tối đa 2 attempt tổng, flatten (không lồng).
async function withRetry(fn, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await fn(attempt); } catch (error) {
      if (attempt === 1) throw new Error(label, { cause: error });
    }
  }
}
async function read(ctx, js, label = 'STATE_READ_FAILED') {
  return withRetry(() => ctx.prim.readState(ctx.page, js), label);
}
async function shot(ctx, label) {
  // Flatten: prim.shot đã retry 2 attempt nội bộ → không bọc thêm retry ở đây.
  const path = await ctx.prim.shot(ctx.page, label);
  await evidence(ctx, label, { path });
  return path;
}
async function click(ctx, label, target) {
  const coord = await ctx.prim.loadCalibration?.(label);
  await withRetry(() => ctx.prim.clickLocate(ctx.page, { ...target, coord }), `${label.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FAILED`);
  await evidence(ctx, label);
}
// Nhịp người thật giữa các micro-bước (500–1200ms).
const humanPause = () => pause(500 + Math.random() * 700);

// --- Validators ---
function requireOwnerRepo(params, actionName) {
  const { owner, repo } = params || {};
  if (typeof owner !== 'string' || !owner.trim()) throw new Error(`${actionName}_MISSING_OWNER`);
  if (typeof repo !== 'string' || !repo.trim()) throw new Error(`${actionName}_MISSING_REPO`);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner.trim())) throw new Error(`${actionName}_INVALID_OWNER`);
  if (!/^[A-Za-z0-9_.-]+$/.test(repo.trim())) throw new Error(`${actionName}_INVALID_REPO`);
  return { owner: owner.trim(), repo: repo.trim() };
}
function requireNumber(value, name, actionName) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw new Error(`${actionName}_INVALID_${name.toUpperCase()}`);
  return n;
}
function requireBody(params, actionName) {
  const { body } = params || {};
  if (typeof body !== 'string' || !body.trim()) throw new Error(`${actionName}_EMPTY_BODY`);
  return body;
}
// idempotency_key bắt buộc cho 3 action ghi. run-action.mjs đã check receipt
// trước dispatch; ở đây chỉ bắt buộc key tồn tại để không chạy mù.
function requireIdempotency(ctx, params, actionName) {
  const key = params?.idempotency_key ?? ctx.idempotencyKey ?? ctx.idempotency_key;
  if (typeof key !== 'string' || !key.trim()) throw new Error(`${actionName}_IDEMPOTENCY_KEY_REQUIRED`);
  return key.trim();
}

// --- Locator (role → text → js) ---
// Comment textarea classic editor (#new_comment_field đã kiểm chứng 2026-10-10).
const commentBoxTarget = {
  role: 'textbox', name: /comment on this/i, text: 'Use Markdown to format your comment',
  js: `() => {
    const isVis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    return document.getElementById('new_comment_field')
      || [...document.querySelectorAll('textarea')].find(e => isVis(e) && /markdown/i.test(e.placeholder || e.getAttribute('aria-label') || ''))
      || [...document.querySelectorAll('textarea[id*="comment" i]')].find(isVis)
      || null;
  }`,
};
const commentButtonTarget = {
  role: 'button', name: /^comment$/i, text: 'Comment',
  js: `() => [...document.querySelectorAll('button,[role="button"]')]
    .find(e => /^comment$/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()) && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && e.getBoundingClientRect().width > 0) || null`,
};
const issueTitleTarget = {
  role: 'textbox', name: /add a title/i, text: 'Title',
  js: `() => document.getElementById('issue_title')
    || document.querySelector('input[name="issue[title]"]')
    || [...document.querySelectorAll('input')].find(e => /title/i.test(e.placeholder || e.getAttribute('aria-label') || '') && e.getBoundingClientRect().width > 0) || null`,
};
const issueBodyTarget = {
  role: 'textbox', name: /comment on this issue/i, text: 'Use Markdown to format your comment',
  js: `() => document.getElementById('issue_body')
    || document.querySelector('textarea[name="issue[body]"]')
    || [...document.querySelectorAll('textarea')].find(e => /type your description|markdown/i.test(e.placeholder || '') && e.getBoundingClientRect().width > 0) || null`,
};
const createButtonTarget = {
  role: 'button', name: /^create\b/i, text: 'Create',
  js: `() => [...document.querySelectorAll('button,[role="button"]')]
    .find(e => /^create\b/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()) && !e.disabled && e.getBoundingClientRect().width > 0) || null`,
};

// --- State readers (js tự chứa, invoke qua expr) ---
// Session: meta[name="user-login"] chỉ tồn tại khi đã login — tín hiệu sạch nhất.
function sessionState() {
  const meta = document.querySelector('meta[name="user-login"]');
  const user = (meta?.content || '').trim() || null;
  const bodyText = (document.body?.innerText || '').slice(0, 2000).toLowerCase();
  const challenge = /just a moment|verify you are human|attention required/.test((document.title || '').toLowerCase() + ' ' + bodyText)
    || Boolean(document.querySelector("iframe[src*='turnstile'], iframe[src*='captcha']"));
  const loginPage = /\/login\b|\/session\b/.test(location.pathname) || /sign in to github/i.test(document.title || '');
  return { loggedIn: Boolean(user) && !challenge && !loginPage, user, url: location.href, challenge };
}
function ensureUsable(s) {
  if (s.challenge) throw new Error('SESSION_CHALLENGE_DETECTED');
  if (!s.loggedIn) throw new Error('SESSION_NOT_LOGGED_IN');
}
// Chuẩn hóa text để so sánh comment: bỏ ký tự markdown, lowercase, gom space.
function normalizeText(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
// GitHub đã đổi trang new-issue sang React id (_R_...) — getElementById('issue_title')
// KHÔNG còn tồn tại. Đọc value qua cùng fallback chain với issueTitleTarget.
// TỰ CHỨA (self-contained): expr() chỉ serialize hàm này.
function issueTitleValue() {
  const el = document.getElementById('issue_title')
    || document.querySelector('input[name="issue[title]"]')
    || [...document.querySelectorAll('input')].find(e => /title/i.test(e.placeholder || e.getAttribute('aria-label') || '') && e.getBoundingClientRect().width > 0);
  return el ? (el.value || '') : '';
}
// Đếm timeline comment + kiểm tra snippet của mình có xuất hiện không.
// GitHub React mới: comment = .react-issue-comment (+ fallback .timeline-comment cũ).
// TỰ CHỨA (self-contained): expr() chỉ serialize hàm này, không kéo helper khác.
function commentPresenceState(snippet) {
  const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const normSnippet = norm(snippet);
  const items = [...document.querySelectorAll('.react-issue-comment, .timeline-comment')];
  const found = items.some(e => norm(e.innerText || '').includes(normSnippet));
  return { count: items.length, found };
}

// Điền textarea và VERIFY nội dung đã vào (đọc lại value).
// React re-render race: GitHub thay node input sau khi điền → chờ 1.5s cho
// React settle rồi mới đọc; nếu trống thì điền lại 1 lần rồi verify.
async function fillAndVerify(ctx, label, target, value) {
  await ctx.prim.fillRobust(ctx.page, target, value);
  await pause(1500); // cho React re-render xong
  let cur = await read(ctx, expr(() => {
    const el = document.getElementById('new_comment_field')
      || document.getElementById('issue_body')
      || [...document.querySelectorAll('textarea')].find(e => e.getBoundingClientRect().width > 0);
    return el ? (el.value || '') : '';
  }), `${label}_READ_FAILED`);
  if (!cur.includes(value.trim().slice(0, 40))) {
    // Node bị thay bởi re-render → điền lại vào node mới rồi đọc lại.
    await ctx.prim.fillRobust(ctx.page, target, value);
    await pause(1500);
    cur = await read(ctx, expr(() => {
      const el = document.getElementById('new_comment_field')
        || document.getElementById('issue_body')
        || [...document.querySelectorAll('textarea')].find(e => e.getBoundingClientRect().width > 0);
      return el ? (el.value || '') : '';
    }), `${label}_READ_FAILED`);
  }
  if (!cur.includes(value.trim().slice(0, 40))) throw new Error(`${label}_VERIFY_FAILED`);
  await evidence(ctx, `${label}.fill`, { length: cur.length });
}
// Sau khi bấm Comment: chờ số comment tăng VÀ text mình xuất hiện trong timeline.
// Không thấy → throw (chống false-positive như bài học chat.send).
async function verifyCommentPosted(ctx, label, countBefore, snippet) {
  const normSnippet = normalizeText(snippet);
  const seen = await withRetry(() => ctx.prim.waitState(ctx.page,
    expr((want, wantCount) => {
      const items = [...document.querySelectorAll('.react-issue-comment, .timeline-comment')];
      const norm = t => (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const found = items.some(e => norm(e.innerText || '').includes(want));
      return items.length > wantCount && found;
    }, normSnippet, countBefore), 25000), `${label}_VERIFY_FAILED`);
  if (!seen) throw new Error(`${label}_VERIFY_FAILED`);
  const final = await read(ctx, expr((s) => {
    const items = [...document.querySelectorAll('.react-issue-comment, .timeline-comment')];
    const last = items[items.length - 1];
    return { count: items.length, lastUrl: last?.querySelector('a[href*="#issuecomment-"]')?.href || null };
  }, normSnippet), `${label}_READ_FAILED`);
  await evidence(ctx, `${label}.verified`, final);
  return final;
}
// Lấy snippet định danh từ body: 60 ký tự đầu sau normalize.
function bodySnippet(body) {
  const n = normalizeText(body);
  return n.slice(0, 60) || n;
}

export const actions = {
  // Kiểm tra session: đã login github.com chưa, user nào (qua meta user-login).
  // Không throw khi chưa login — đó chính là thông tin cần trả.
  'session.check': async (ctx) => {
    await shot(ctx, 'session.check-before');
    const s = await read(ctx, expr(sessionState), 'SESSION_READ_FAILED');
    await evidence(ctx, 'session.check', s);
    await shot(ctx, 'session.check-after');
    return ok({ loggedIn: s.loggedIn, user: s.user, url: s.url, challenge: s.challenge });
  },

  // Comment vào issue. Mở trang issue → điền comment box → bấm Comment →
  // VERIFY comment thực sự xuất hiện (đếm + text). Ghi receipt kèm comment URL.
  'issue.comment': async (ctx, params = {}) => {
    const { owner, repo } = requireOwnerRepo(params, 'ISSUE_COMMENT');
    const issue_number = requireNumber(params.issue_number, 'issue_number', 'ISSUE_COMMENT');
    const body = requireBody(params, 'ISSUE_COMMENT');
    const idemKey = requireIdempotency(ctx, params, 'ISSUE_COMMENT');
    const s = await read(ctx, expr(sessionState), 'SESSION_READ_FAILED');
    ensureUsable(s);
    await shot(ctx, 'issue.comment-before');
    const url = `${GITHUB_BASE}/${owner}/${repo}/issues/${issue_number}`;
    await withRetry(() => ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }), 'ISSUE_PAGE_NOT_READY');
    await humanPause();
    // Chờ trang issue load: tiêu đề issue hoặc form comment xuất hiện.
    await withRetry(() => ctx.prim.waitState(ctx.page,
      expr(() => Boolean(document.getElementById('new_comment_field')) || /comment/i.test(document.body?.innerText || '')), 25000), 'ISSUE_PAGE_NOT_READY');
    const pageState = await read(ctx, expr(() => ({ url: location.href, title: document.title || '' })), 'ISSUE_PAGE_READ_FAILED');
    if (!pageState.url.includes(`/issues/${issue_number}`)) throw new Error('ISSUE_NOT_FOUND');
    if (/page not found|not found/i.test(pageState.title) && !/issues/i.test(pageState.url)) throw new Error('ISSUE_NOT_FOUND');
    await evidence(ctx, 'issue.comment.open', { url: pageState.url });
    const before = await read(ctx, expr(commentPresenceState, bodySnippet(body)), 'ISSUE_COMMENT_READ_FAILED');
    await fillAndVerify(ctx, 'ISSUE_COMMENT', commentBoxTarget, body);
    await humanPause();
    // Nút Comment của GitHub là React controlled (aria-disabled) — click tọa độ có thể
    // trượt như vụ nút Create split-button. Submit bằng Ctrl+Enter (shortcut chuẩn GitHub).
    await read(ctx, expr(() => { const ta = document.getElementById('new_comment_field') || document.querySelector('textarea'); if (ta) ta.focus(); return Boolean(ta); }), 'ISSUE_COMMENT_FOCUS_FAILED');
    await ctx.prim.pressKey(ctx.page, 'Control+Enter');
    await evidence(ctx, 'issue.comment.submitted', { idempotency_key: idemKey, via: 'ctrl+enter' });
    const final = await verifyCommentPosted(ctx, 'ISSUE_COMMENT', before.count, bodySnippet(body));
    await shot(ctx, 'issue.comment-after');
    return ok({ issue_url: pageState.url, comment_url: final.lastUrl, comment_count: final.count, idempotency_key: idemKey });
  },

  // Tạo issue mới. Mở /issues/new → điền title + body → bấm Create →
  // verify redirect sang trang issue mới. KHÔNG merge/close/xóa gì khác.
  'issue.create': async (ctx, params = {}) => {
    const { owner, repo } = requireOwnerRepo(params, 'ISSUE_CREATE');
    const title = (params.title || '');
    if (typeof params.title !== 'string' || !title.trim()) throw new Error('ISSUE_CREATE_MISSING_TITLE');
    const body = requireBody(params, 'ISSUE_CREATE');
    const idemKey = requireIdempotency(ctx, params, 'ISSUE_CREATE');
    const s = await read(ctx, expr(sessionState), 'SESSION_READ_FAILED');
    ensureUsable(s);
    await shot(ctx, 'issue.create-before');
    await withRetry(() => ctx.page.goto(`${GITHUB_BASE}/${owner}/${repo}/issues/new`, { waitUntil: 'domcontentloaded', timeout: 30000 }), 'ISSUE_NEW_PAGE_NOT_READY');
    await humanPause();
    await withRetry(() => ctx.prim.waitState(ctx.page,
      expr(() => Boolean(document.getElementById('issue_title')) || /add a title/i.test(document.body?.innerText || '')), 25000), 'ISSUE_NEW_PAGE_NOT_READY');
    // Flatten: fillRobust đã retry 2 attempt nội bộ → không bọc thêm retry ở đây.
    await ctx.prim.fillRobust(ctx.page, issueTitleTarget, title);
    await pause(1500); // cho React re-render xong rồi mới đọc lại node mới
    let curTitle = await read(ctx, expr(issueTitleValue), 'ISSUE_TITLE_READ_FAILED');
    if (curTitle.trim() !== title.trim()) {
      await ctx.prim.fillRobust(ctx.page, issueTitleTarget, title);
      await pause(1500);
      curTitle = await read(ctx, expr(issueTitleValue), 'ISSUE_TITLE_READ_FAILED');
    }
    if (curTitle.trim() !== title.trim()) throw new Error('ISSUE_TITLE_VERIFY_FAILED');
    await evidence(ctx, 'issue.create.fill:title');
    await fillAndVerify(ctx, 'ISSUE_BODY', issueBodyTarget, body);
    await humanPause();
    // Nút Create là split-button: click tọa độ trúng caret sẽ mở menu thay vì submit
    // (đã verify thật). GitHub quảng cáo shortcut "control ⌃ enter ⏎" trên nút → submit
    // bằng Ctrl+Enter sau khi focus vào textarea.
    await read(ctx, expr(() => { const ta = document.querySelector('textarea'); if (ta) ta.focus(); return Boolean(ta); }), 'ISSUE_FOCUS_FAILED');
    await ctx.prim.pressKey(ctx.page, 'Control+Enter');
    await evidence(ctx, 'issue.create.submitted', { idempotency_key: idemKey, via: 'ctrl+enter' });
    // Verify: redirect khỏi /issues/new sang /issues/{number}.
    const created = await withRetry(() => ctx.prim.waitState(ctx.page,
      expr(() => {
        const m = location.pathname.match(/\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
        return m ? `${location.origin}${m[0]}` : null;
      }), 25000), 'ISSUE_CREATE_VERIFY_FAILED');
    if (!created) throw new Error('ISSUE_CREATE_VERIFY_FAILED');
    await evidence(ctx, 'issue.create.verified', { issue_url: created });
    await shot(ctx, 'issue.create-after');
    const issue_number = Number(created.match(/\/issues\/(\d+)$/)[1]);
    return ok({ issue_url: created, issue_number, idempotency_key: idemKey });
  },

  // Comment vào discussion. Comment box cấu trúc tương tự issue.
  // VERIFY comment thực sự xuất hiện, giống issue.comment.
  'discussion.comment': async (ctx, params = {}) => {
    const { owner, repo } = requireOwnerRepo(params, 'DISCUSSION_COMMENT');
    const discussion_number = requireNumber(params.discussion_number, 'discussion_number', 'DISCUSSION_COMMENT');
    const body = requireBody(params, 'DISCUSSION_COMMENT');
    const idemKey = requireIdempotency(ctx, params, 'DISCUSSION_COMMENT');
    const s = await read(ctx, expr(sessionState), 'SESSION_READ_FAILED');
    ensureUsable(s);
    await shot(ctx, 'discussion.comment-before');
    const url = `${GITHUB_BASE}/${owner}/${repo}/discussions/${discussion_number}`;
    await withRetry(() => ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }), 'DISCUSSION_PAGE_NOT_READY');
    await humanPause();
    // Cuộn xuống cuối để comment form của discussion render.
    await withRetry(async () => {
      await ctx.prim.readState(ctx.page, expr(() => { window.scrollTo(0, document.body.scrollHeight); return true; }));
      return ctx.prim.waitState(ctx.page,
        expr(() => [...document.querySelectorAll('textarea')].some(e => {
          const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
        })), 20000);
    }, 'DISCUSSION_PAGE_NOT_READY');
    const pageState = await read(ctx, expr(() => ({ url: location.href, title: document.title || '' })), 'DISCUSSION_PAGE_READ_FAILED');
    if (!pageState.url.includes(`/discussions/${discussion_number}`)) throw new Error('DISCUSSION_NOT_FOUND');
    await evidence(ctx, 'discussion.comment.open', { url: pageState.url });
    const before = await read(ctx, expr(commentPresenceState, bodySnippet(body)), 'DISCUSSION_COMMENT_READ_FAILED');
    await fillAndVerify(ctx, 'DISCUSSION_COMMENT', commentBoxTarget, body);
    await humanPause();
    // Giống issue.comment: submit bằng Ctrl+Enter thay vì click tọa độ.
    await read(ctx, expr(() => { const ta = document.querySelector('textarea'); if (ta) ta.focus(); return Boolean(ta); }), 'DISCUSSION_COMMENT_FOCUS_FAILED');
    await ctx.prim.pressKey(ctx.page, 'Control+Enter');
    await evidence(ctx, 'discussion.comment.submitted', { idempotency_key: idemKey, via: 'ctrl+enter' });
    const final = await verifyCommentPosted(ctx, 'DISCUSSION_COMMENT', before.count, bodySnippet(body));
    await shot(ctx, 'discussion.comment-after');
    return ok({ discussion_url: pageState.url, comment_url: final.lastUrl, comment_count: final.count, idempotency_key: idemKey });
  },
};
