import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

interface TooltipProps {
  label: string;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactNode;
}

export const Tooltip: React.FC<TooltipProps> = ({
  label,
  shortcut,
  side = 'bottom',
  children,
}) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tip = tooltipRef.current;
    if (!trigger || !tip) return;

    const tr = trigger.getBoundingClientRect();
    const tt = tip.getBoundingClientRect();
    const gap = 6;
    const pad = 8;

    let effectiveSide = side;
    if (side === 'bottom' && tr.bottom + gap + tt.height > window.innerHeight - pad) {
      effectiveSide = 'top';
    } else if (side === 'top' && tr.top - gap - tt.height < pad) {
      effectiveSide = 'bottom';
    } else if (side === 'left' && tr.left - gap - tt.width < pad) {
      effectiveSide = 'right';
    } else if (side === 'right' && tr.right + gap + tt.width > window.innerWidth - pad) {
      effectiveSide = 'left';
    }

    let top = 0;
    let left = 0;

    if (effectiveSide === 'bottom') {
      top = tr.bottom + gap;
      left = tr.left + tr.width / 2 - tt.width / 2;
    } else if (effectiveSide === 'top') {
      top = tr.top - tt.height - gap;
      left = tr.left + tr.width / 2 - tt.width / 2;
    } else if (effectiveSide === 'left') {
      top = tr.top + tr.height / 2 - tt.height / 2;
      left = tr.left - tt.width - gap;
    } else {
      top = tr.top + tr.height / 2 - tt.height / 2;
      left = tr.right + gap;
    }

    const clampedLeft = Math.max(pad, Math.min(left, window.innerWidth - tt.width - pad));
    const clampedTop = Math.max(pad, Math.min(top, window.innerHeight - tt.height - pad));

    setCoords({ top: clampedTop, left: clampedLeft });
  }, [side]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    computePosition();
    window.addEventListener('resize', computePosition);
    window.addEventListener('scroll', computePosition, true);
    return () => {
      window.removeEventListener('resize', computePosition);
      window.removeEventListener('scroll', computePosition, true);
    };
  }, [open, computePosition, label, shortcut]);

  return (
    <div
      ref={triggerRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={tooltipRef}
                role="tooltip"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.11, ease: [0.16, 1, 0.3, 1] }}
                style={{
                  position: 'fixed',
                  top: coords ? `${coords.top}px` : '-9999px',
                  left: coords ? `${coords.left}px` : '-9999px',
                  visibility: coords ? 'visible' : 'hidden',
                }}
                className="pointer-events-none z-[100] flex items-center gap-2 whitespace-nowrap rounded-md border border-[#272B38] bg-[#1E222E] px-2.5 py-1 text-[11px] font-medium text-[#E6E8EE] shadow-xl"
              >
                <span>{label}</span>
                {shortcut && (
                  <kbd className="font-mono text-[10px] text-[#8B92A5]">{shortcut}</kbd>
                )}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </div>
  );
};
