# Quy tắc làm việc với repo này

Chủ repo (Mondiro) là artist, không phải lập trình viên. Trả lời bằng tiếng Việt, giải thích dễ hiểu.

## Phiên bản và phát hành

- **Mặc định: làm xong là phát hành luôn** — tự nâng `version` trong `package.json` (sửa lỗi nhỏ: +0.0.1,
  tính năng mới: +0.1.0) và push lên `main`. Chỉ khi Mondiro dặn **"đợi"** / "chưa phát hành" thì mới
  chỉ commit mà không nâng version.
- Nội dung bảng thông báo cập nhật lấy từ `release-notes.md` (tiêu đề `# v<version>` + các dòng bên dưới).
  Nếu Mondiro có note thì ghi **đúng** những dòng đó. Nếu không có note thì Claude tự viết 1–3 dòng ngắn,
  tiếng Việt, mô tả thay đổi theo cách người dùng hiểu — **không chép commit message**.
- Đổi `version` (hoặc `release-notes.md`) rồi push lên `main` thì GitHub Actions sẽ tự build và phát hành.
  App đã cài sẽ tự cập nhật. Sau khi push, chờ build xong và báo kết quả.

## Bí mật

- Không ghi phím tắt mở bảng Admin vào bất kỳ file công khai nào (README, release notes, commit message).
  Repo đang để Public.
