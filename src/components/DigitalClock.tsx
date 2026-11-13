import React, { useEffect, useState } from 'react';
import { Tooltip } from './Tooltip';

interface DigitalClockProps {
  variant: 'hero' | 'topbar';
}

const CLOCK_FMT_KEY = 'aetheris.clock24h';

export const DigitalClock: React.FC<DigitalClockProps> = ({ variant }) => {
  const [now, setNow] = useState(() => new Date());
  const [use24Hour, setUse24Hour] = useState(() => {
    try {
      const saved = localStorage.getItem(CLOCK_FMT_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const toggleFormat = () => {
    setUse24Hour((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CLOCK_FMT_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const hours24 = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const displayHours = use24Hour
    ? String(hours24).padStart(2, '0')
    : String(hours24 % 12 || 12).padStart(2, '0');
  const meridiem = use24Hour ? '' : hours24 >= 12 ? ' PM' : ' AM';

  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  if (variant === 'hero') {
    return (
      <div className="flex flex-col items-center text-center select-none">
        <button
          type="button"
          onClick={toggleFormat}
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

  return (
    <Tooltip label={`${dateLabel} (click for ${use24Hour ? '12h' : '24h'})`}>
      <button
        type="button"
        onClick={toggleFormat}
        className="rounded-md px-2 py-1 font-mono text-[12px] font-medium tabular-nums text-[#B5BBC9] hover:bg-[#1E222E] hover:text-[#E6E8EE] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#6366F1]"
      >
        {displayHours}:{minutes}
        <span className="text-[#8B92A5]">:{seconds}</span>
        {meridiem}
      </button>
    </Tooltip>
  );
};
