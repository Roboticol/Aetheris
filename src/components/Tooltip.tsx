import React, { useState } from 'react';
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

  const positionClasses: Record<NonNullable<TooltipProps['side']>, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  };

  return (
    <div
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <AnimatePresence>
        {open && (
          <motion.div
            role="tooltip"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
            className={`pointer-events-none absolute z-50 flex items-center gap-2 whitespace-nowrap rounded-md border border-[#272B38] bg-[#1E222E] px-2.5 py-1 text-[11px] font-medium text-[#E6E8EE] shadow-lg ${positionClasses[side]}`}
          >
            <span>{label}</span>
            {shortcut && (
              <kbd className="font-mono text-[10px] text-[#8B92A5]">{shortcut}</kbd>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
