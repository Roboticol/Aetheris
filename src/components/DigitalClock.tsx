import React, { useEffect, useRef, useState } from 'react';
import { Check, Clock } from 'lucide-react';
import { Tooltip } from './Tooltip';

interface DigitalClockProps {
  variant: 'hero' | 'topbar';
}

interface TopbarClockConfig {
  showHours: boolean;
  showMinutes: boolean;
  showSeconds: boolean;
  use24Hour: boolean;
}

const HERO_FMT_KEY = 'aetheris.clock24h';
const TOPBAR_CFG_KEY = 'aetheris.topbarClockConfig';

const DEFAULT_TOPBAR_CONFIG: TopbarClockConfig = {
  showHours: true,
  showMinutes: true,
  showSeconds: true,
  use24Hour: true,
};

function loadTopbarConfig(): TopbarClockConfig {
  try {
    const raw = localStorage.getItem(TOPBAR_CFG_KEY);
    if (!raw) return DEFAULT_TOPBAR_CONFIG;
    const parsed = JSON.parse(raw) as Partial<TopbarClockConfig>;
    const cfg: TopbarClockConfig = {
      showHours: parsed.showHours ?? true,
      showMinutes: parsed.showMinutes ?? true,
      showSeconds: parsed.showSeconds ?? true,
      use24Hour: parsed.use24Hour ?? true,
    };
    if (!cfg.showHours && !cfg.showMinutes && !cfg.showSeconds) {
      cfg.showHours = true;
      cfg.showMinutes = true;
    }
    return cfg;
  } catch {
    return DEFAULT_TOPBAR_CONFIG;
  }
}

export const DigitalClock: React.FC<DigitalClockProps> = ({ variant }) => {
  const [now, setNow] = useState(() => new Date());
  const [hero24h, setHero24h] = useState(() => {
    try {
      const saved = localStorage.getItem(HERO_FMT_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [topbarCfg, setTopbarCfg] = useState<TopbarClockConfig>(() => loadTopbarConfig());
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const toggleHeroFormat = () => {
    setHero24h((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(HERO_FMT_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const updateTopbarCfg = (updater: (prev: TopbarClockConfig) => TopbarClockConfig) => {
    setTopbarCfg((prev) => {
      const next = updater(prev);
      if (!next.showHours && !next.showMinutes && !next.showSeconds) {
        return prev;
      }
      try {
        localStorage.setItem(TOPBAR_CFG_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const hours24 = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  if (variant === 'hero') {
    const displayHours = hero24h
      ? String(hours24).padStart(2, '0')
      : String(hours24 % 12 || 12).padStart(2, '0');
    const meridiem = hero24h ? '' : hours24 >= 12 ? ' PM' : ' AM';

    return (
      <div className="flex flex-col items-center text-center select-none">
        <button
          type="button"
          onClick={toggleHeroFormat}
          title="Click to toggle 24h / 12h clock"
          className="group inline-flex items-baseline gap-1 font-mono tabular-nums tracking-tight text-[#E6E8EE] hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6366F1] rounded-md px-2 py-0.5"
        >
          <span className="text-5xl sm:text-6xl font-semibold">
            {displayHours}:{minutes}
          </span>
          <span className="text-2xl sm:text-3xl font-medium text-[#818CF8]">
            :{seconds}
          </span>
          {meridiem && (
            <span className="ml-1.5 text-lg font-medium text-[#8B92A5]">
              {meridiem.trim()}
            </span>
          )}
        </button>
        <div className="mt-1.5 text-[12.5px] font-medium text-[#8B92A5]">
          {dateLabel}
        </div>
      </div>
    );
  }

  const displayHours = topbarCfg.use24Hour
    ? String(hours24).padStart(2, '0')
    : String(hours24 % 12 || 12).padStart(2, '0');
  const meridiem =
    !topbarCfg.use24Hour && topbarCfg.showHours ? (hours24 >= 12 ? ' PM' : ' AM') : '';

  const activeUnitCount =
    Number(topbarCfg.showHours) + Number(topbarCfg.showMinutes) + Number(topbarCfg.showSeconds);

  const renderTopbarDigits = () => {
    const { showHours, showMinutes, showSeconds } = topbarCfg;

    if (showHours && showMinutes && showSeconds) {
      return (
        <>
          {displayHours}:{minutes}
          <span className="text-[#8B92A5]">:{seconds}</span>
          {meridiem}
        </>
      );
    }
    if (showHours && showMinutes) {
      return (
        <>
          {displayHours}:{minutes}
          {meridiem}
        </>
      );
    }
    if (showHours && showSeconds) {
      return (
        <>
          {displayHours}h{' '}
          <span className="text-[#8B92A5]">{seconds}s</span>
          {meridiem}
        </>
      );
    }
    if (showMinutes && showSeconds) {
      return (
        <>
          {minutes}m <span className="text-[#8B92A5]">{seconds}s</span>
        </>
      );
    }
    if (showHours) {
      return (
        <>
          {displayHours}
          {meridiem || 'h'}
        </>
      );
    }
    if (showMinutes) {
      return <>{minutes}m</>;
    }
    return <span className="text-[#8B92A5]">{seconds}s</span>;
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <Tooltip label={`${dateLabel} · Right-click to customize clock`}>
        <button
          type="button"
          onClick={() => updateTopbarCfg((c) => ({ ...c, use24Hour: !c.use24Hour }))}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuOpen((prev) => !prev);
          }}
          className="rounded-md px-2 py-1 font-mono text-[12px] font-medium tabular-nums text-[#B5BBC9] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6366F1]"
        >
          {renderTopbarDigits()}
        </button>
      </Tooltip>

      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenuOpen(false)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuOpen(false);
            }}
          />
          <div className="absolute right-0 top-full z-50 mt-1.5 w-52 rounded-lg border border-[#272B38] bg-[#161922] p-1.5 shadow-xl">
            <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-[#8B92A5]">
              <Clock className="h-3 w-3 text-[#818CF8]" />
              <span>Clock Modules</span>
            </div>

            {(
              [
                { key: 'showHours', label: 'Hours' },
                { key: 'showMinutes', label: 'Minutes' },
                { key: 'showSeconds', label: 'Seconds' },
              ] as const
            ).map((item) => {
              const checked = topbarCfg[item.key];
              const isLastActive = checked && activeUnitCount <= 1;
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={isLastActive}
                  onClick={() =>
                    updateTopbarCfg((c) => ({ ...c, [item.key]: !c[item.key] }))
                  }
                  className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12px] text-[#E6E8EE] hover:bg-[#1E222E] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                >
                  <span>{item.label}</span>
                  {checked && <Check className="h-3.5 w-3.5 text-[#818CF8]" />}
                </button>
              );
            })}

            <div className="my-1 h-px bg-[#272B38]" />

            <button
              type="button"
              onClick={() =>
                updateTopbarCfg((c) => ({ ...c, use24Hour: !c.use24Hour }))
              }
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12px] text-[#E6E8EE] hover:bg-[#1E222E] transition-colors"
            >
              <span>24-Hour Format</span>
              {topbarCfg.use24Hour && <Check className="h-3.5 w-3.5 text-[#818CF8]" />}
            </button>
          </div>
        </>
      )}
    </div>
  );
};
