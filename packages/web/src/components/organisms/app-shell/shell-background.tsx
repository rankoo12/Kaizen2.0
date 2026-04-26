'use client';

import { useEffect, useRef } from 'react';

type Node = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
};

type Props = {
  intensity?: number;
  density?: number;
};

export function ShellBackground({ intensity = 0.55, density = 60 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number | null>(null);
  const reducedRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedRef.current = mq.matches;
    const handler = (e: MediaQueryListEvent) => { reducedRef.current = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0;
    let nodes: Node[] = [];

    function readColor(name: string): string {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || '#888';
    }

    function setup() {
      if (!canvas || !ctx) return;
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.floor(density * (w * h) / (1280 * 800));
      nodes = Array.from({ length: Math.max(20, count) }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: Math.random() * 1.4 + 0.4,
        phase: Math.random() * Math.PI * 2,
      }));
    }
    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(canvas);

    function step(t: number) {
      if (!ctx) return;
      const colorA = readColor('--color-neural-a');
      const colorB = readColor('--color-neural-b');
      const colorC = readColor('--color-neural-c');

      ctx.clearRect(0, 0, w, h);

      // Soft radial wash anchored to upper-right (offset from where the side rail sits).
      const grad = ctx.createRadialGradient(w * 0.65, h * 0.35, 0, w * 0.65, h * 0.35, Math.max(w, h) * 0.7);
      grad.addColorStop(0, hexToRgba(colorB, 0.06));
      grad.addColorStop(0.6, hexToRgba(colorC, 0.04));
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      const time = t / 1000;

      // Update positions.
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!reducedRef.current) {
          n.x += n.vx;
          n.y += n.vy;
        }
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
        n.x = Math.max(0, Math.min(w, n.x));
        n.y = Math.max(0, Math.min(h, n.y));
      }

      // Connecting lines.
      const linkDist = 140;
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < linkDist) {
            const alpha = (1 - d / linkDist) * 0.16;
            ctx.strokeStyle = hexToRgba(colorA, alpha);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Nodes — pulsing core + soft glow.
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const pulse = 0.5 + 0.5 * Math.sin(time * 0.6 + n.phase);
        const r = n.r + pulse * 0.6;

        ctx.fillStyle = hexToRgba(colorB, 0.05 + pulse * 0.05);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = hexToRgba(colorA, 0.55 + pulse * 0.4);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(step);
    }
    animRef.current = requestAnimationFrame(step);

    return () => {
      ro.disconnect();
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
    };
  }, [density]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0"
      style={{ opacity: intensity }}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}

function hexToRgba(hex: string, a: number): string {
  if (!hex) return `rgba(128,128,128,${a})`;
  const trimmed = hex.trim();

  // Already an rgb()/rgba() — substitute alpha.
  if (trimmed.startsWith('rgb')) {
    const nums = trimmed.match(/[\d.]+/g);
    if (!nums || nums.length < 3) return `rgba(128,128,128,${a})`;
    return `rgba(${nums[0]}, ${nums[1]}, ${nums[2]}, ${a})`;
  }

  let h = trimmed.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(128,128,128,${a})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
