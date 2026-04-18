'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

type NeuralBackgroundProps = {
  anchors: Array<React.RefObject<HTMLDivElement | null>>;
};

export function NeuralBackground({ anchors }: NeuralBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || typeof window === 'undefined') return;

    const canvas = canvasRef.current;
    const scene = new THREE.Scene();
    
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 15;

    const renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      alpha: true
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const neuralGroup = new THREE.Group();
    scene.add(neuralGroup);

    // 1. Glowing Inner Core (Updated to Brand Orange)
    const coreGeo = new THREE.IcosahedronGeometry(1.5, 1);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x130d17,
      emissive: 0xd5601c, // brandOrange
      emissiveIntensity: 0.6,
      wireframe: true
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    neuralGroup.add(core);

    // 2. Outer Neural Shell (Updated to Brand Pink)
    const outerGeo = new THREE.IcosahedronGeometry(3, 2);
    const outerMat = new THREE.MeshStandardMaterial({
      color: 0xdb87af, // brandPink
      emissive: 0xdb87af, // brandPink
      emissiveIntensity: 0.3,
      wireframe: true,
      transparent: true,
      opacity: 0.5
    });
    const outer = new THREE.Mesh(outerGeo, outerMat);
    neuralGroup.add(outer);

    // 3. Floating Data Particles (Updated to Button Pink)
    const particlesGeo = new THREE.BufferGeometry();
    const particlesCount = 700;
    const posArray = new Float32Array(particlesCount * 3);
    for (let i = 0; i < particlesCount * 3; i++) {
        posArray[i] = (Math.random() - 0.5) * 25; // Spread across 25 units
    }
    particlesGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const particlesMat = new THREE.PointsMaterial({
        size: 0.08,
        color: 0xebd1de, // buttonPinkStart
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending
    });
    const particleSystem = new THREE.Points(particlesGeo, particlesMat);
    scene.add(particleSystem);

    // Lighting matching new colors
    const pointLight1 = new THREE.PointLight(0xd5601c, 2, 20); // brandOrange
    pointLight1.position.set(5, 5, 5);
    scene.add(pointLight1);

    const pointLight2 = new THREE.PointLight(0xdb87af, 2, 20); // brandPink
    pointLight2.position.set(-5, -5, -5);
    scene.add(pointLight2);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambientLight);

    // Base offset to shift the 3D model to the right side to balance the UI
    const baseOffsetX = 2.5;
    neuralGroup.position.x = baseOffsetX;
    particleSystem.position.x = baseOffsetX;

    // Create 3D Anchors for the Stars to Orbit
    const starAnchors: THREE.Object3D[] = [];
    const anchorPositions = [
        new THREE.Vector3(3.5, 2.5, 1.5),   // Anchor 1
        new THREE.Vector3(-3.0, -3.5, 2.0), // Anchor 2
        new THREE.Vector3(1.5, 1.0, -4.0)   // Anchor 3
    ];

    anchorPositions.forEach(pos => {
        const anchor = new THREE.Object3D();
        anchor.position.copy(pos);
        neuralGroup.add(anchor);
        starAnchors.push(anchor);
    });

    const clock = new THREE.Clock();
    const tempV = new THREE.Vector3();
    let animationFrameId: number;

    function animate() {
        animationFrameId = requestAnimationFrame(animate);
        const elapsedTime = clock.getElapsedTime();

        // Smooth base rotation
        neuralGroup.rotation.y += 0.002;
        neuralGroup.rotation.x += 0.001;

        // Counter rotate the core for complexity
        core.rotation.y -= 0.005;
        core.rotation.z += 0.002;

        // Rotate particles slowly
        particleSystem.rotation.y = -elapsedTime * 0.02;

        // Project 3D Anchors to 2D Screen Space for Stars
        starAnchors.forEach((anchor, i) => {
            const starEl = anchors[i]?.current;
            
            // Freeze star position if it is being hovered
            if (!starEl || starEl.dataset.hovered === 'true') return;

            // Get world position of the anchor
            anchor.getWorldPosition(tempV);

            // Check if the point is on the back-half of the sphere (z < 0)
            const isBehind = tempV.z < 0;

            // Project to 2D screen coordinates
            tempV.project(camera);
            const x = (tempV.x * 0.5 + 0.5) * window.innerWidth;
            const y = -(tempV.y * 0.5 - 0.5) * window.innerHeight;

            // Update CSS transform with depth scale
            const scale = isBehind ? 0.7 : 1;
            starEl.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;

            // Fade and disable interactions if star rotates behind the model
            if (isBehind) {
                starEl.style.opacity = '0.15';
                starEl.style.pointerEvents = 'none';
                starEl.style.filter = 'blur(2px)';
            } else {
                starEl.style.opacity = '1';
                starEl.style.pointerEvents = 'auto';
                starEl.style.filter = 'none';
            }
        });

        renderer.render(scene, camera);
    }

    animate();

    // Handle Window Resize
    const handleResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
        window.removeEventListener('resize', handleResize);
        cancelAnimationFrame(animationFrameId);
        
        scene.traverse((object) => {
            if (object instanceof THREE.Mesh) {
                if (object.geometry) object.geometry.dispose();
                if (object.material) {
                    if (Array.isArray(object.material)) {
                        object.material.forEach(mat => mat.dispose());
                    } else {
                        object.material.dispose();
                    }
                }
            }
        });
        renderer.dispose();
    };
  }, [anchors]);

  return (
    <canvas 
      ref={canvasRef} 
      className="fixed top-0 left-0 w-screen h-screen z-0 pointer-events-none" 
    />
  );
}
