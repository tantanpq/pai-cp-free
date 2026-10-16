# rea-cp — REA Control Plane (build-time map tool)

Thành viên thứ 5 của MSI Control Plane. Không điều khiển dịch vụ nào —
nó quét trang web ra **bản đồ** để coding agent build control plane không đoán.

## Deploy

```bash
bash ~/workspace/rea-control-plane/deploy.sh < /dev/null
```

Target: `C:\temp\rea-cp\` trên MSI. Tuyệt đối không đụng
`suno-cp`, `chatgpt-cp`, `github-cp`, `grok-cp`, `chatgpt`, `social`.

## Dùng

```bash
# 1. Quét 1 URL (read-only, không click/submit)
node C:\temp\rea-cp\proto\run-action.mjs '{"action":"map.scan","params":{"url":"https://grok.com/imagine","observationMs":3000}}'

# 2. Đối chiếu selector với map đã quét
node C:\temp\rea-cp\proto\run-action.mjs '{"action":"map.diff","params":{"mapFile":"C:\\temp\\rea-cp\\evidence\\<runId>\\<ts>-map.json","checks":[{"id":"video-mode","role":"radio","namePattern":"^video$"},{"id":"prompt-box","role":"textbox","namePattern":"ask grok anything"}]}}'
```

Kết quả mỗi action: 1 dòng JSON trên stdout + evidence dir
(`screenshot` từng bước + `steps.jsonl` + map/diff JSON).

## Khách hàng đầu tiên

`grok-cp` — 3/5 selector đã calibrate từ bản đồ REA
(`~/workspace/grok-control-plane/SELECTOR_CALIBRATION.md`).
Tiếp theo: `chatgpt-cp`, `github-cp`.

## Luật cứng

- Read-only: mở + quan sát. Không click, không điền, không submit, không paid.
- Không anti-bot/CAPTCHA evasion. Không rewrite config agent.
- Retry phẳng ≤2 attempt. Mọi action có evidence, không evidence = chưa xong.
