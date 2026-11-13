import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Cpu, Download, Terminal, X } from 'lucide-react';

interface NativeDesktopModalProps {
  open: boolean;
  onClose: () => void;
}

export const NativeDesktopModal: React.FC<NativeDesktopModalProps> = ({ open, onClose }) => {
  const [platformTab, setPlatformTab] = useState<'arch' | 'linux' | 'windows'>('arch');

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/65 backdrop-blur-[1px]"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-10 w-full max-w-2xl overflow-hidden rounded-lg border border-[#272B38] bg-[#161922] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#272B38] px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <Cpu className="h-4 w-4 text-[#818CF8]" />
                <h2 className="text-[14px] font-semibold text-[#E6E8EE]">
                  Compile Native Rust Desktop Binary (Tauri v2)
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded p-1 text-[#8B92A5] hover:bg-[#1E222E] hover:text-[#E6E8EE]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-[12.5px] text-[#B5BBC9]">
              <p className="leading-relaxed">
                Aetheris ships a complete <strong className="text-[#E6E8EE]">Rust + Tauri v2</strong>{' '}
                desktop core using OS-native rendering (<code className="font-mono text-[#818CF8]">webkit2gtk-4.1</code>{' '}
                on Linux, <code className="font-mono text-[#818CF8]">WebView2</code> on Windows) for
                a ~50 MB idle memory footprint without Electron.
              </p>

              <div className="flex items-center gap-1 rounded-md bg-[#0F1117] p-1 w-fit">
                <button
                  type="button"
                  onClick={() => setPlatformTab('arch')}
                  className={`rounded px-3 py-1 text-[12px] font-medium transition-colors whitespace-nowrap ${
                    platformTab === 'arch'
                      ? 'bg-[#1E222E] text-[#E6E8EE]'
                      : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                  }`}
                >
                  Arch / KDE Plasma
                </button>
                <button
                  type="button"
                  onClick={() => setPlatformTab('linux')}
                  className={`rounded px-3 py-1 text-[12px] font-medium transition-colors whitespace-nowrap ${
                    platformTab === 'linux'
                      ? 'bg-[#1E222E] text-[#E6E8EE]'
                      : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                  }`}
                >
                  Universal Linux (AppImage)
                </button>
                <button
                  type="button"
                  onClick={() => setPlatformTab('windows')}
                  className={`rounded px-3 py-1 text-[12px] font-medium transition-colors whitespace-nowrap ${
                    platformTab === 'windows'
                      ? 'bg-[#1E222E] text-[#E6E8EE]'
                      : 'text-[#8B92A5] hover:text-[#E6E8EE]'
                  }`}
                >
                  Windows 10 / 11
                </button>
              </div>

              <div className="rounded-md border border-[#272B38] bg-[#0F1117] p-3.5 font-mono text-[12px] text-[#E6E8EE] space-y-2 overflow-x-auto">
                {platformTab === 'arch' && (
                  <pre className="whitespace-pre-wrap">{`# 1. Install native WebKitGTK & Rust toolchain on Arch Linux
sudo pacman -S --needed webkit2gtk-4.1 base-devel openssl librsvg rust cargo

# 2. Extract the downloaded bundle and compile natively (or use src-tauri/arch/PKGBUILD)
npm install && cargo install tauri-cli
cargo tauri build

# KDE Plasma Wayland + NVIDIA tip (if needed):
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./src-tauri/target/release/aetheris`}</pre>
                )}

                {platformTab === 'linux' && (
                  <pre className="whitespace-pre-wrap">{`# Build a portable AppImage + .deb + .rpm for any Linux distribution
npm install
cargo install tauri-cli
cargo tauri build --bundles appimage,deb`}</pre>
                )}

                {platformTab === 'windows' && (
                  <pre className="whitespace-pre-wrap">{`# Build lightweight native WebView2 installer (.exe / .msi) on Windows
npm install
cargo install tauri-cli
cargo tauri build --bundles nsis,msi`}</pre>
                )}
              </div>

              <div className="rounded-md border border-[#272B38] bg-[#0F1117] p-3 text-[12px]">
                <div className="flex items-center gap-2 font-medium text-[#E6E8EE]">
                  <Terminal className="h-3.5 w-3.5 text-[#818CF8]" />
                  <span>Google AI Studio API Key in Native Desktop Mode</span>
                </div>
                <p className="mt-1 text-[#8B92A5]">
                  The native Rust binary reads <code className="font-mono text-[#E6E8EE]">GEMINI_API_KEY</code>{' '}
                  from your environment, your OS keyring (KWallet / Windows Credential Manager), or{' '}
                  <code className="font-mono text-[#E6E8EE]">~/.config/aetheris/config.toml</code>.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 border-t border-[#272B38] bg-[#161922] px-5 py-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[#272B38] bg-[#1E222E] px-3.5 py-1.5 text-[12px] font-medium text-[#E6E8EE] hover:bg-[#272B38] transition-colors"
              >
                Close
              </button>
              <a
                href="/api/desktop-bundle"
                download="aetheris-rust-desktop.zip"
                className="flex items-center gap-2 rounded-md bg-[#6366F1] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-[#818CF8] transition-colors whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Download Rust/Tauri Source (.zip)</span>
              </a>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
