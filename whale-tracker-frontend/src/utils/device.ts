/** 设备与入口分流（屏宽为主，可用 query 强制） */
export const MOBILE_BREAKPOINT = 768;

export function isMobileViewport(width = window.innerWidth) {
  return width <= MOBILE_BREAKPOINT;
}

export function readViewForce(): 'mobile' | 'desktop' | null {
  try {
    const q = new URLSearchParams(window.location.search).get('view');
    if (q === 'mobile' || q === 'm') return 'mobile';
    if (q === 'desktop' || q === 'pc') return 'desktop';
  } catch {
    // ignore
  }
  return null;
}
