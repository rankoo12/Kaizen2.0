/* global React */

// Neural network background — calmer than three.js, but maintains the brand DNA.
// Animated point cloud + connecting lines, draws on a 2D canvas, easy on perf.
function NeuralBackground({ intensity = 0.55, density = 60 }) {
  const canvasRef = React.useRef(null);
  const animRef = React.useRef(null);
  const reducedRef = React.useRef(false);

  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedRef.current = mq.matches;
    const handler = (e) => { reducedRef.current = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0;
    let nodes = [];

    function readColor(name) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || '#888';
    }

    function setup() {
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

    function step(t) {
      const colorA = readColor('--neural-color-a');
      const colorB = readColor('--neural-color-b');
      const colorC = readColor('--neural-color-c');

      ctx.clearRect(0, 0, w, h);
      // soft radial wash
      const grad = ctx.createRadialGradient(w * 0.6, h * 0.4, 0, w * 0.6, h * 0.4, Math.max(w, h) * 0.7);
      grad.addColorStop(0, hexToRgba(colorB, 0.05));
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      const time = t / 1000;
      // update + draw lines
      const linkDist = 140;
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

      // links
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < linkDist) {
            const alpha = (1 - d / linkDist) * 0.18;
            ctx.strokeStyle = hexToRgba(colorA, alpha);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // nodes
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const pulse = 0.5 + 0.5 * Math.sin(time * 0.6 + n.phase);
        const r = n.r + pulse * 0.6;
        // glow
        ctx.fillStyle = hexToRgba(colorB, 0.05 + pulse * 0.05);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 4, 0, Math.PI * 2);
        ctx.fill();
        // core
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
      cancelAnimationFrame(animRef.current);
    };
  }, [density]);

  return (
    <div className="neural-bg" style={{ opacity: intensity }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

function hexToRgba(hex, a) {
  if (!hex) return `rgba(128,128,128,${a})`;
  if (hex.startsWith('rgb')) {
    return hex.replace(/rgba?\(/, 'rgba(').replace(/\)$/, `,${a})`).replace(/,\s*[\d.]+\)$/, `,${a})`);
  }
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

window.NeuralBackground = NeuralBackground;
