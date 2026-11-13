# Native Desktop Build Notes

This directory holds the Rust + Tauri v2 backend (`src-tauri/src/lib.rs`) and Arch Linux `PKGBUILD` (`src-tauri/arch/PKGBUILD`).

## Arch Linux (KDE Plasma)

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg rust cargo
npm install
cargo install tauri-cli
cargo tauri build
```

If you run KDE Plasma on Wayland with an NVIDIA GPU and hit blank rendering frames in WebKitGTK:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./target/release/aetheris
```

## Universal Linux & Windows Bundles

```bash
# AppImage / deb / rpm
cargo tauri build --bundles appimage,deb

# Windows installer
cargo tauri build --bundles nsis,msi
```

## API Key Config

Export `GEMINI_API_KEY` in your shell, store it in your system keyring (`aetheris` / `gemini_api_key`), or put it in `~/.config/aetheris/config.toml`:

```toml
gemini_api_key = "your_google_ai_studio_key"
```
