# CLAUDE.md — echoly-extension

Extension Chrome MV3 (**TypeScript + WXT**) — **lồng tiếng voice-to-voice** trên mọi trang có `<video>` (YouTube, Coursera, Udemy, …). Background là nguồn trạng thái duy nhất; content bắt audio tab và chạy 2 tier: **Realtime** (WebRTC OpenAI) và **Standard** (WebRTC Gemini audio-in + TTS, hoặc YouTube VOD qua phụ đề + `/v1/translate/subtitles`); popup renderer thụ động.

## Tài liệu kiến trúc (Understand-Anything knowledge graph)

Repo này có sẵn **knowledge graph tiếng Việt** tại `.understand-anything/knowledge-graph.json` — gồm tóm tắt từng file/function, 7 **layers** (entrypoints, background, content, popup, shared, test, hạ tầng), và một **tour** 13 bước.

- **Khi nào dùng:** câu hỏi về kiến trúc tổng thể, layers, luồng tier pipeline, onboarding, "cái này hoạt động ra sao" — ưu tiên tham khảo graph này trước (qua `/understand-chat`, `/understand-explain`, hoặc đọc trực tiếp node/layer liên quan). Đừng đọc nguyên file lớn nếu chỉ cần vài node.
- **Khi nào KHÔNG cần:** câu hỏi cấu trúc sống ("hàm X gọi ở đâu", "đổi Z hỏng gì", "định nghĩa ở đâu") — dùng CodeWiki/CodeGraph MCP như global CLAUDE.md đã hướng dẫn.
- **Tự cập nhật:** `autoUpdate: true` — graph tự cập nhật tăng dần khi commit qua Claude Code (commit từ bên trong thư mục repo này). Nội dung giữ **tiếng Việt** (`outputLanguage: vi`).
