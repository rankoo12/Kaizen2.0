/* global React, Icon */

const { useEffect: useEffectWel, useRef: useRefWel, useState: useStateWel } = React;

// ─── Welcome screen with Three.js neural orb ─────────────────────────────────
function WelcomeScreen({ onLogin, onSignup }) {
  const canvasRef = useRefWel(null);
  const star1Ref = useRefWel(null);
  const star2Ref = useRefWel(null);
  const star3Ref = useRefWel(null);
  const [ready, setReady] = useStateWel(false);

  useEffectWel(() => {
    if (!window.THREE) return;
    const THREE = window.THREE;
    const canvas = canvasRef.current;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 15;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const neuralGroup = new THREE.Group();
    scene.add(neuralGroup);

    // Inner core
    const coreGeo = new THREE.IcosahedronGeometry(1.5, 1);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x130d17,
      emissive: 0xd5601c,
      emissiveIntensity: 0.6,
      wireframe: true,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    neuralGroup.add(core);

    // Mid shell
    const midGeo = new THREE.IcosahedronGeometry(2.2, 1);
    const midMat = new THREE.MeshStandardMaterial({
      color: 0xd5601c,
      emissive: 0xd5601c,
      emissiveIntensity: 0.18,
      wireframe: true,
      transparent: true,
      opacity: 0.25,
    });
    const mid = new THREE.Mesh(midGeo, midMat);
    neuralGroup.add(mid);

    // Outer shell
    const outerGeo = new THREE.IcosahedronGeometry(3, 2);
    const outerMat = new THREE.MeshStandardMaterial({
      color: 0xdb87af,
      emissive: 0xdb87af,
      emissiveIntensity: 0.3,
      wireframe: true,
      transparent: true,
      opacity: 0.5,
    });
    const outer = new THREE.Mesh(outerGeo, outerMat);
    neuralGroup.add(outer);

    // Particles
    const particlesGeo = new THREE.BufferGeometry();
    const particlesCount = 800;
    const posArray = new Float32Array(particlesCount * 3);
    for (let i = 0; i < particlesCount * 3; i++) {
      posArray[i] = (Math.random() - 0.5) * 28;
    }
    particlesGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const particlesMat = new THREE.PointsMaterial({
      size: 0.07,
      color: 0xebd1de,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
    });
    const particleSystem = new THREE.Points(particlesGeo, particlesMat);
    scene.add(particleSystem);

    // Lights
    const pl1 = new THREE.PointLight(0xd5601c, 2.4, 20);
    pl1.position.set(5, 5, 5);
    scene.add(pl1);
    const pl2 = new THREE.PointLight(0xdb87af, 2.4, 20);
    pl2.position.set(-5, -5, -5);
    scene.add(pl2);
    scene.add(new THREE.AmbientLight(0xffffff, 0.3));

    // Offset to right side of screen
    const baseOffsetX = 3.0;
    neuralGroup.position.x = baseOffsetX;
    particleSystem.position.x = baseOffsetX;

    // Anchors for orbiting stars
    const anchorPositions = [
      new THREE.Vector3(3.5, 2.5, 1.5),
      new THREE.Vector3(-3.0, -3.5, 2.0),
      new THREE.Vector3(1.5, 1.0, -4.0),
    ];
    const starAnchors = anchorPositions.map((p) => {
      const a = new THREE.Object3D();
      a.position.copy(p);
      neuralGroup.add(a);
      return a;
    });

    const stars = [star1Ref.current, star2Ref.current, star3Ref.current];
    stars.forEach((s) => {
      if (!s) return;
      s.dataset.hovered = 'false';
      s.addEventListener('mouseenter', () => (s.dataset.hovered = 'true'));
      s.addEventListener('mouseleave', () => (s.dataset.hovered = 'false'));
    });

    const clock = new THREE.Clock();
    const tempV = new THREE.Vector3();
    let raf;
    let mounted = true;

    function animate() {
      if (!mounted) return;
      raf = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();

      neuralGroup.rotation.y += 0.0025;
      neuralGroup.rotation.x += 0.0011;
      core.rotation.y -= 0.005;
      core.rotation.z += 0.002;
      mid.rotation.y += 0.003;
      mid.rotation.x -= 0.002;
      particleSystem.rotation.y = -t * 0.02;

      // Subtle breathing
      const breath = 1 + Math.sin(t * 0.7) * 0.03;
      core.scale.setScalar(breath);

      // Project anchors to screen-space
      starAnchors.forEach((anchor, i) => {
        const star = stars[i];
        if (!star || star.dataset.hovered === 'true') return;
        anchor.getWorldPosition(tempV);
        const isBehind = tempV.z < 0;
        tempV.project(camera);
        const x = (tempV.x * 0.5 + 0.5) * window.innerWidth;
        const y = -(tempV.y * 0.5 - 0.5) * window.innerHeight;
        const scale = isBehind ? 0.7 : 1;
        star.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
        if (isBehind) {
          star.style.opacity = '0.15';
          star.style.pointerEvents = 'none';
          star.style.filter = 'blur(2px)';
        } else {
          star.style.opacity = '1';
          star.style.pointerEvents = 'auto';
          star.style.filter = 'none';
        }
      });

      renderer.render(scene, camera);
    }

    animate();
    setReady(true);

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      coreGeo.dispose(); coreMat.dispose();
      midGeo.dispose(); midMat.dispose();
      outerGeo.dispose(); outerMat.dispose();
      particlesGeo.dispose(); particlesMat.dispose();
    };
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, overflow: 'hidden',
      background: 'var(--welcome-bg)', color: 'var(--text-hi)',
      fontFamily: "'Geist', system-ui, sans-serif",
    }}>
      <canvas ref={canvasRef} style={{
        position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
        zIndex: 0, pointerEvents: 'none',
      }} />

      {/* Vignette */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 1, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at 70% 50%, transparent 30%, rgba(19,13,23,0.6) 80%)',
      }} />

      {/* Top bar */}
      <header style={{
        position: 'relative', zIndex: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '24px 48px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
          <div className="font-accent" style={{
            fontSize: 22, fontWeight: 700, letterSpacing: '0.04em',
            display: 'flex', alignItems: 'center', gap: 0,
          }}>
            <span style={{ color: 'var(--text-hi)' }}>KAI</span>
            <span style={{ color: 'var(--brand-primary)' }}>ZEN</span>
          </div>
          <nav style={{ display: 'flex', gap: 24, fontSize: 13 }}>
            <a href="#" style={{ color: 'var(--text-hi)', textDecoration: 'none', position: 'relative', paddingBottom: 4 }}>
              Product
              <span style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: 2, background: 'var(--brand-primary)' }} />
            </a>
            <a href="#" style={{ color: 'var(--text-mid)', textDecoration: 'none' }}>How it works</a>
            <a href="#" style={{ color: 'var(--text-mid)', textDecoration: 'none' }}>Pricing</a>
            <a href="#" style={{ color: 'var(--text-mid)', textDecoration: 'none' }}>Docs</a>
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--text-mid)' }}>
          <StatusPip />
          <span>2.1M browser steps healed this week</span>
        </div>
      </header>

      {/* Hero */}
      <main style={{
        position: 'relative', zIndex: 10,
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        height: 'calc(100vh - 84px)', padding: '0 48px',
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          gap: 40, maxWidth: 580,
        }}>
          {/* Eyebrow */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            padding: '6px 12px', alignSelf: 'flex-start',
            background: 'rgba(213, 96, 28, 0.08)',
            border: '1px solid rgba(213, 96, 28, 0.25)',
            borderRadius: 999,
            fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: '0.12em', textTransform: 'uppercase',
            color: 'var(--brand-primary-soft)',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: 'var(--brand-primary)',
              boxShadow: '0 0 10px var(--brand-primary-glow)',
            }} />
            v0.9 · self-healing engine
          </div>

          {/* Title — Instrument Serif italic for the punch word */}
          <h1 className="font-display" style={{
            fontSize: 'clamp(48px, 6vw, 76px)',
            fontWeight: 600, lineHeight: 0.98, letterSpacing: '-0.025em',
            color: 'var(--text-hi)', margin: 0,
          }}>
            The QA brain that <em style={{
              fontFamily: "'Instrument Serif', serif", fontWeight: 400, fontStyle: 'italic',
              color: 'var(--brand-primary-soft)', letterSpacing: '-0.01em',
            }}>thinks</em><br />
            in plain English.
          </h1>

          <p style={{
            fontSize: 17, lineHeight: 1.5, color: 'var(--text-mid)',
            margin: 0, maxWidth: 480,
          }}>
            Write tests like you write product specs. Kaizen compiles them into a
            real browser, recovers from drift, and tells you <em style={{ fontFamily: "'Instrument Serif', serif", color: 'var(--text-hi)', fontStyle: 'italic' }}>why</em> a
            run failed — not just where.
          </p>

          {/* CTAs */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 320 }}>
            <button onClick={onSignup} style={{
              padding: '14px 18px', borderRadius: 12, border: 'none',
              background: 'linear-gradient(135deg, var(--brand-accent-soft) 0%, var(--brand-accent-mid) 100%)',
              color: '#1a0e05', fontWeight: 600, fontSize: 14,
              cursor: 'pointer',
              boxShadow: '0 0 30px rgba(219, 135, 175, 0.3), 0 6px 16px rgba(0,0,0,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'transform 0.15s, box-shadow 0.15s',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 0 40px rgba(219, 135, 175, 0.5), 0 8px 20px rgba(0,0,0,0.5)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 0 30px rgba(219, 135, 175, 0.3), 0 6px 16px rgba(0,0,0,0.4)'; }}
            >
              Start your workspace <Icon name="arrowRight" size={14} />
            </button>
            <button onClick={onLogin} style={{
              padding: '14px 18px', borderRadius: 12,
              border: '1px solid rgba(213, 96, 28, 0.4)',
              background: 'rgba(26, 18, 29, 0.55)', backdropFilter: 'blur(10px)',
              color: 'var(--brand-primary-soft)', fontWeight: 500, fontSize: 14,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'background 0.15s',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(213, 96, 28, 0.10)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(26, 18, 29, 0.55)'; }}
            >
              Sign in
            </button>
          </div>

          {/* Trust strip */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            paddingTop: 8, borderTop: '1px solid var(--border-subtle)',
          }}>
            <div className="eyebrow" style={{ fontSize: 9 }}>trusted by quality teams at</div>
            <div style={{
              display: 'flex', gap: 28, alignItems: 'center', flexWrap: 'wrap',
              opacity: 0.6, fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13, letterSpacing: '0.05em', color: 'var(--text-mid)',
            }}>
              <span style={{ fontWeight: 600 }}>NORTHSTAR</span>
              <span style={{ fontWeight: 600 }}>plumbline</span>
              <span style={{ fontWeight: 600 }}>Cadence∎</span>
              <span style={{ fontWeight: 600 }}>folium.</span>
              <span style={{ fontWeight: 600 }}>HALCYON</span>
            </div>
          </div>
        </div>

        {/* Right column intentionally empty — 3D fills it via canvas */}
        <div />
      </main>

      {/* Bottom-left meta */}
      <div style={{
        position: 'fixed', bottom: 28, left: 48, zIndex: 10,
        display: 'flex', alignItems: 'center', gap: 16,
        fontSize: 11, color: 'var(--text-low)',
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        <span>SOC 2 · type II</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>EU + US data residency</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>99.97% uptime</span>
      </div>

      {/* Floating star anchors with hover-cards */}
      <FloatingStar
        ref={star1Ref} kind="pink"
        title="Plain-English specs"
        body="Write what a user does. Kaizen resolves selectors, waits, and intent."
      />
      <FloatingStar
        ref={star2Ref} kind="orange"
        title="Self-healing"
        body="When the DOM drifts, Kaizen patches selectors mid-run and logs the change."
      />
      <FloatingStar
        ref={star3Ref} kind="pink"
        title="Truthful failures"
        body="Every red step ships with a screenshot, a trace, and a reason in english."
      />
    </div>
  );
}

const FloatingStar = React.forwardRef(function FloatingStar({ kind, title, body }, ref) {
  const c = kind === 'orange'
    ? { bg: '#d5601c', glow: 'rgba(213, 96, 28, 0.7)', glowH: 'rgba(213, 96, 28, 1)' }
    : { bg: '#db87af', glow: 'rgba(219, 135, 175, 0.7)', glowH: 'rgba(219, 135, 175, 1)' };

  return (
    <div ref={ref} className="welcome-star group" style={{
      position: 'fixed', top: 0, left: 0, zIndex: 50,
      transform: 'translate(-100vw, -100vh)',
      willChange: 'transform',
      transition: 'opacity 0.3s, filter 0.3s',
      cursor: 'pointer',
    }}>
      <div className="welcome-star-cube" style={{
        width: 16, height: 16, borderRadius: 2,
        background: c.bg,
        boxShadow: `0 0 12px 2px ${c.glow}`,
        position: 'relative', overflow: 'hidden',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        '--glow-hover': c.glowH,
      }}>
        <span className="welcome-star-shine" style={{
          position: 'absolute', top: 0, left: '-150%',
          width: '100%', height: '100%',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent)',
          transform: 'skewX(-20deg)',
        }} />
      </div>
      <div className="welcome-star-card" style={{
        position: 'absolute', left: '50%', transform: 'translateX(-50%)',
        marginTop: 14, width: 220, padding: '10px 12px',
        background: 'rgba(26, 18, 29, 0.92)', backdropFilter: 'blur(14px)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 10,
        opacity: 0, pointerEvents: 'none',
        transition: 'opacity 0.25s',
        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-hi)', marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-mid)', lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
});

function StatusPip() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 8px', borderRadius: 999,
      background: 'rgba(34, 197, 94, 0.08)',
      border: '1px solid rgba(34, 197, 94, 0.20)',
      fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--success)',
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: 'var(--success)',
        boxShadow: '0 0 6px var(--success-glow)',
        animation: 'orbit 0s', // placeholder
      }} />
      live
    </span>
  );
}

window.WelcomeScreen = WelcomeScreen;
