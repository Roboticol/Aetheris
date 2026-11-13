# Aetheris

A lightweight agentic code editor built with Rust (Tauri v2) and CodeMirror 6, meant for Linux and Windows machines where Electron-based editors feel too heavy.

I wanted something with the multi-file AI workflow of tools like Cursor or Antigravity, without shipping another bundled Chromium instance and eating half a gigabyte of RAM just to edit a few source files.

## Why Tauri v2 + CodeMirror 6

- **Low memory usage**: Instead of bundling Chromium like Electron, Tauri reuses the system webview (`webkit2gtk-4.1` on Linux, `WebView2` on Windows) and keeps file walking, symbol scanning, shell execution, and Gemini API calls in Rust.
- **Fast editor core**: Uses CodeMirror 6 instead of Monaco, so only visible lines are rendered and large files stay responsive on older laptops.
- **Runs natively or in local dev mode**: The frontend talks through a small transport layer—using Tauri IPC when built as a native binary, or a local Express server / browser directory picker during development.

## What's Inside

- **File Explorer**: Tree view with create, rename, and delete, plus local folder opening and a couple of starter workspaces.
- **Syntax-Highlighted Editor**: Multi-tab CodeMirror 6 setup with grammars for Rust, TypeScript/JavaScript, Python, JSON, HTML, CSS, and Markdown.
- **Multi-File Agent + Diff Review**: Uses Google's Gemini API (`gemini-4-hydrogen`) with Fast/Deep reasoning modes. Instead of silently overwriting files, it proposes structured `create`, `modify`, and `delete` patches with a line-by-line diff view so you can accept or reject per file (or accept all).
- **Project-Wide Symbol & Text Search**: Scans workspace files for `fn`, `struct`, `enum`, `trait`, `impl`, `function`, `class`, `interface`, `const`, and `def`, or plain text matches, and jumps straight to the line.
- **Integrated Terminal**: Collapsible command runner with history (`Up`/`Down`), stdout/stderr output, and exit codes.

## Building on Linux (Arch / KDE Plasma & Other Distros)

I daily-drive Arch with KDE Plasma, so there is a `PKGBUILD` included under `src-tauri/arch/PKGBUILD` alongside standard Tauri bundling for AppImage / `.deb` / `.rpm`.

Install the system dependencies on Arch:

```bash
sudo pacman -Syu --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg rust cargo
```

Install JS dependencies and build the native binary:

```bash
npm install
cargo install tauri-cli
cargo tauri build
```

For a distro-agnostic bundle:

```bash
cargo tauri build --bundles appimage
```

> **Note for KDE Plasma Wayland**:
> - If you launch the raw `./src-tauri/target/release/aetheris` binary directly instead of installing via `PKGBUILD`, Wayland falls back to a generic `W` taskbar icon until a matching `.desktop` file exists. Install it locally once:
>   `install -Dm644 src-tauri/arch/dev.aetheris.ide.desktop ~/.local/share/applications/dev.aetheris.ide.desktop && install -Dm644 src-tauri/icons/icon.png ~/.local/share/icons/hicolor/128x128/apps/aetheris.png`
> - On NVIDIA + Wayland, if `webkit2gtk-4.1` shows blank compositor frames, launch with `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./src-tauri/target/release/aetheris`.

## Building on Windows

Windows 11 includes WebView2 out of the box (Windows 10 installs it automatically if missing).

```powershell
npm install
cargo install tauri-cli
cargo tauri build --bundles nsis,msi
```

## Google AI Studio API Key Setup

In the native desktop build, Aetheris checks for your Google AI Studio key in this order:

1. `GEMINI_API_KEY` environment variable
2. Your OS keyring (`aetheris` / `gemini_api_key` via KWallet, Secret Service, or Windows Credential Manager)
3. `~/.config/aetheris/config.toml` on Linux (or `%APPDATA%\aetheris\config.toml` on Windows):

```toml
gemini_api_key = "your_google_ai_studio_key"
```

## Running in Local Dev Mode

If you just want to hack on the UI or test changes without compiling the Rust binary every time:

```bash
cp .env.example .env
# add your GEMINI_API_KEY to .env
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+P` / `Ctrl+K` | Quick-open file or symbol |
| `Ctrl+Shift+F` | Project-wide search & symbols |
| `Ctrl+S` | Save current file |
| `Ctrl+B` | Toggle explorer sidebar |
| `Ctrl+\`` | Toggle terminal |
| `Ctrl+L` | Toggle agent panel |
