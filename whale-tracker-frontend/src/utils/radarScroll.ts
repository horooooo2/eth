const animations = new WeakMap<Element, number>();

export function scrollRadarToTop(origin: Element, duration = 300) {
  // The radar scrolls inside its host, rather than the browser window.
  const container = origin.closest('.tradfi-host') || document.scrollingElement;
  if (!container) return;
  const previous = animations.get(container);
  if (previous !== undefined) cancelAnimationFrame(previous);
  const from = container.scrollTop;
  if (from <= 0) { animations.delete(container); return; }
  const started = performance.now();
  function frame(now: number) {
    if (!container!.isConnected) { animations.delete(container!); return; }
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - (1 - progress) ** 3;
    container!.scrollTo({ top: from * (1 - eased), behavior: 'instant' });
    if (progress < 1) animations.set(container!, requestAnimationFrame(frame));
    else animations.delete(container!);
  }
  animations.set(container, requestAnimationFrame(frame));
}
