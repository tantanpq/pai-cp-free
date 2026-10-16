# GitHub Control Plane — Build spec (Tân duyệt 2026-10-10 23:35)

Web thứ 3 trong tầm nhìn "master control" (sau Suno, ChatGPT). Lý do: tool GitHub CLI write (`github call-tool`) bị thẻ approve mỗi lần, KHÔNG có always-allow (Tân check kỹ 23:35) — đi đường browser để hết phiền.

## Kiến trúc (copy từ Suno/ChatGPT Control Plane)
- Tham chiếu: `~/workspace/zmedia-music/SUNO_CONTROL_PLANE_V1.md`, `SUNO_CONTROL_PLANE_SPEC.md`, source `~/workspace/suno-control-plane/`, `~/workspace/chatgpt-control-plane/`.
- Tái dùng `proto/`, `primitives/`, `watch/` — không duplicate. Chỉ viết mới `actions-github/registry.mjs`.
- Deploy lên MSI tại `C:\temp\github-cp\`.

## Phạm vi — CHỈ WRITE (read giữ nguyên tool API, không bị approve)
1. `session.check` — đã login github.com chưa, user nào.
2. `issue.comment` — comment vào issue (owner/repo, issue_number, body). Dùng chính cho relay Issue #19.
3. `issue.create` — tạo issue mới (owner/repo, title, body).
4. `discussion.comment` — comment vào discussion (cho Council HQ).

## Môi trường MSI
- Chrome dùng chung port **9336** (profile social đã có TikTok/FB/Suno).
- **Prerequisite cho dry-run:** Tân login github.com 1 lần trên cửa sổ Chrome MSI (chưa confirm đã login ở đó).

## Luật cứng
- KHÔNG merge, KHÔNG close/reopen, KHÔNG xóa, KHÔNG push code, KHÔNG đụng setting repo.
- Chỉ comment/tạo issue/discussion — đúng việc Tân hay làm.
- Mọi action: evidence (screenshot + steps.jsonl).
- Nhịp người thật; lỗi lặp 2 lần → dừng đổi cách.

## QA
- 4 lane viết song song → 1 lane QA dò lỗi (mẫu Suno/ChatGPT).
- `node --check` toàn bộ trước khi báo xong.

## Dry-run (sau khi em review + Tân login MSI)
`session.check` → `issue.comment` 1 comment test vô hại lên issue riêng (không phải #19) → verify hiện đúng.
