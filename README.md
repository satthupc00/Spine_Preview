# Mondiro Spine Preview

**Phiên bản:** 2.1.1 · **Tác giả:** Mondiro

Công cụ desktop (Windows) để xem trước và xuất animation từ **Spine 3.7.94**. Kéo thả file `.json` export từ Spine vào app để xem animation, dựng Sequence nhiều layer, mix animation và kiểm tra timing theo frame hoặc giây.

## Tính năng chính

- Xem trước animation Spine 3.7.94 (json + atlas + png)
- **Sequencer**: xếp nhiều animation theo timeline, mixer anim giữa các clip
- **Loop / Loop Locally**: mỗi layer tự lặp danh sách anim của nó (giống prefab trong engine game)
- Thanh scrub có nút Play/Stop, hiển thị thời gian theo **Frame** hoặc **Giây**
- Quét chọn, reset khung nhìn
- **Changes Log** đọc từ `changelog.txt` – sửa file này là thấy thay đổi, không cần build lại

## Cấu trúc thư mục

| File | Vai trò |
|---|---|
| `main.js` | Tiến trình chính Electron (cửa sổ, menu, đọc changelog) |
| `renderer.js` | Giao diện & logic của app |
| `spine-stage.js` | Phần hiển thị Spine bằng PixiJS + pixi-spine |
| `index.html` / `styles.css` | Giao diện |
| `changelog.txt` | Nhật ký cập nhật (sửa tay được) |
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

## Công nghệ

Electron 30 · PixiJS 7 · pixi-spine 4

---

Created by **Mondiro**
