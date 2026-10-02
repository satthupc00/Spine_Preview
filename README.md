# Mondiro Spine Preview

**Phiên bản:** 2.2.2 · **Tác giả:** Mondiro

Công cụ desktop (Windows) để xem trước và xuất animation từ **Spine 3.7.94**. Kéo thả file `.json` export từ Spine vào app để xem animation, dựng Sequence nhiều layer, mix animation và kiểm tra timing theo frame hoặc giây.

## Tính năng chính

- Xem trước animation Spine 3.7.94 (json + atlas + png)
- **Sequencer**: xếp nhiều animation theo timeline, mixer anim giữa các clip
- **Loop / Loop Locally**: mỗi layer tự lặp danh sách anim của nó (giống prefab trong engine game)
- Thanh scrub có nút Play/Stop, hiển thị thời gian theo **Frame** hoặc **Giây**
- Quét chọn, reset khung nhìn
- Hiện chữ **(latest)** màu xanh sau số phiên bản khi đang dùng bản mới nhất
- **Tự động cập nhật**: có bản mới là app trên máy đồng nghiệp tự tải và hỏi khởi động lại
- **Key kích hoạt + bảng Admin**: cấp, thu hồi, xóa quyền dùng app của từng người

## Cấu trúc thư mục

| File | Vai trò |
|---|---|
| `main.js` | Tiến trình chính Electron (cửa sổ, xuất PNG) |
| `renderer.js` | Giao diện & logic của app |
| `spine-stage.js` | Phần hiển thị Spine bằng PixiJS + pixi-spine |
| `license.js` / `license-ui.js` | Kiểm tra key, màn hình khóa, bảng Admin |
| `updater.js` | Tự động cập nhật từ GitHub Releases |
| `access/keys.json` | Danh sách key (chỉ lưu mã băm, không lộ key) – sửa qua bảng Admin |
| `release-notes.md` | Nội dung bảng thông báo cập nhật của bản sắp phát hành |
| `.github/workflows/release.yml` | Tự build file cài đặt và đăng bản mới khi đổi version |
| `index.html` / `styles.css` | Giao diện |
| `build/icon.ico` | Icon app |

## Cài đặt & chạy

Cần cài [Node.js](https://nodejs.org) (bản LTS).

```bash
npm install      # cài thư viện (chỉ cần làm 1 lần)
npm start        # chạy app ở chế độ phát triển
```

## Build file .exe (Windows)

```bash
npm run dist            # build cả bản portable + installer
npm run dist:folder     # chỉ build ra thư mục (nhanh, để test)
npm run dist:installer  # chỉ build bản cài đặt (NSIS)
```

File build nằm trong thư mục `dist/`.

## Phát hành bản mới (tự động cập nhật)

1. Sửa code, đổi `"version"` trong `package.json` (ví dụ `2.2.2` → `2.2.3`).
2. Ghi nội dung muốn hiện trong bảng thông báo cập nhật vào `release-notes.md`:
   ```
   # v2.2.3
   - Thêm tính năng ...
   ```
   Tiêu đề phải trùng version, nếu không GitHub sẽ không build.
3. Push lên nhánh `main`.

GitHub Actions sẽ tự build `SpinePreview-<version>-setup.exe` và đăng lên mục **Releases** (khoảng 5–10 phút, xem ở tab **Actions**).
App trên máy đồng nghiệp kiểm tra bản mới lúc mở app và mỗi 1 tiếng, tự tải về, rồi hỏi
"Cập nhật ngay / Để sau". Chọn "Để sau" thì lần tắt app tới sẽ tự cài.

> **Lưu ý:**
> - Repo phải để **Public** thì app mới tải được bản cập nhật.
> - Chỉ bản cài bằng **Setup .exe** mới tự cập nhật, bản portable thì không.
> - Máy đang dùng bản 2.1.1 trở về trước cần cài tay bản 2.2.0 một lần, từ đó về sau mới tự cập nhật.

## Quản lý quyền sử dụng (key)

### Lần đầu: tạo GitHub token cho Admin

1. Vào GitHub → ảnh đại diện → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Đặt tên (ví dụ `Spine Preview Admin`) và chọn thời hạn.
3. **Repository access** → **Only select repositories** → chọn `Spine_Preview`.
4. **Permissions** → **Contents** → **Read and write**.
5. Bấm **Generate token** rồi copy token (bắt đầu bằng `github_pat_`).

### Dùng bảng Admin

- Mở bảng Admin bằng phím tắt riêng (chỉ Mondiro biết) → dán token → **Đăng nhập Admin**.
  Token được mã hóa và chỉ lưu trên máy bạn. Máy đã đăng nhập Admin thì luôn dùng được app.
- **Tạo key mới**: nhập tên đồng nghiệp → **+ Tạo key mới**. Ở dòng của người đó bấm **Hiện** để xem key (dạng `SPV-XXXX-XXXX-XXXX-XXXX`) hoặc **Copy** để gửi cho họ.
- Key chỉ lưu trên máy đã tạo ra nó (đăng xuất Admin không làm mất). Dòng nào báo "Key không lưu trên máy này" thì bấm **Đổi key** để tạo key mới cho người đó.
  Họ mở app, nhập key một lần là dùng được.
- **Thu hồi**: khóa tạm, có thể **Mở lại** sau. **Xóa**: xóa hẳn, key đó không dùng lại được.
- Sau khi thu hồi hoặc xóa, máy kia sẽ bị khóa trong khoảng **15–20 phút** (hoặc ngay lần mở app tiếp theo).

> **Lưu ý:**
> - Tên và ghi chú của key hiện công khai trong `access/keys.json` trên GitHub. Bản thân key thì không lộ, vì file chỉ lưu mã băm.
> - Nếu mất mạng, máy đã kích hoạt vẫn dùng được thêm **7 ngày** kể từ lần kiểm tra thành công gần nhất.
> - Đây là cách khóa mức cơ bản cho nội bộ team, đủ để chặn người dùng thông thường, nhưng không chống được người cố tình sửa app.

## Công nghệ

Electron 30 · PixiJS 7 · pixi-spine 4 · electron-updater

---

Created by **Mondiro**
