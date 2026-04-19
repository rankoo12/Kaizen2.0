'use client';

import { useRef } from 'react';
import { NeuralBackground } from './neural-background';

type WelcomeHeroProps = {
  onLogin?: () => void;
  onSignUp?: () => void;
};

export function WelcomeHero({ onLogin, onSignUp }: WelcomeHeroProps) {
  const star1Ref = useRef<HTMLDivElement>(null);
  const star2Ref = useRef<HTMLDivElement>(null);
  const star3Ref = useRef<HTMLDivElement>(null);

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.dataset.hovered = 'true';
  };
  const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.dataset.hovered = 'false';
  };

  return (
    <>
      <NeuralBackground anchors={[star1Ref, star2Ref, star3Ref]} />

      <main className="flex-1 flex flex-col md:flex-row w-full h-full relative z-10 px-8 md:px-16 lg:px-24">
          {/* Left Side: Logo and Buttons */}
          <div className="w-full md:w-1/2 h-full flex flex-col justify-center items-start space-y-12">
              {/* Logo */}
              <div className="text-3xl md:text-4xl font-bold tracking-wider cursor-pointer font-space">
                  <span>KAI</span><span className="text-brand-orange">ZEN</span>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col space-y-4 w-full max-w-[320px]">
                  {/* Login Button */}
                  <button
                      onClick={onLogin}
                      className="w-full py-4 rounded-xl border border-brand-orange/50 text-brand-orange font-medium bg-[#1a121d]/80 hover:bg-brand-orange/10 transition-all backdrop-blur-sm">
                      Login
                  </button>

                  {/* Sign Up Button */}
                  <button
                      onClick={onSignUp}
                      className="w-full py-4 rounded-xl bg-gradient-to-r from-brand-pink-light to-brand-pink-mid text-black font-semibold hover:opacity-90 transition-opacity shadow-[0_0_20px_rgba(219,135,175,0.2)]">
                      Sign Up
                  </button>
              </div>
          </div>

          {/* Interactive Stars (Fixed in 3D Space) */}
          <div ref={star1Ref} id="star-1" data-hovered="false"
              onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}
              className="fixed top-0 left-0 group cursor-pointer z-50 transition-opacity duration-300 pointer-events-auto"
              style={{ transform: 'translate(-100vw, -100vh)', willChange: 'transform' }}>
              <div className="glowing-cube cube-pink animate-pulse">
                  <div className="shine-effect"></div>
              </div>
              <div
                  className="absolute opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-[#1a121d]/90 backdrop-blur-md border border-white/10 p-4 rounded-lg mt-4 w-48 text-sm text-gray-300 left-1/2 -translate-x-1/2 shadow-2xl z-50 text-center pointer-events-none">
                  Core Inference
              </div>
          </div>

          <div ref={star2Ref} id="star-2" data-hovered="false"
              onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}
              className="fixed top-0 left-0 group cursor-pointer z-50 transition-opacity duration-300 pointer-events-auto"
              style={{ transform: 'translate(-100vw, -100vh)', willChange: 'transform' }}>
              <div className="glowing-cube cube-orange animate-pulse" style={{ animationDelay: '0.5s' }}>
                  <div className="shine-effect"></div>
              </div>
              <div
                  className="absolute opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-[#1a121d]/90 backdrop-blur-md border border-white/10 p-4 rounded-lg mt-4 w-48 text-sm text-gray-300 left-1/2 -translate-x-1/2 shadow-2xl z-50 text-center pointer-events-none">
                  Learned Compiler
              </div>
          </div>

          <div ref={star3Ref} id="star-3" data-hovered="false"
              onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}
              className="fixed top-0 left-0 group cursor-pointer z-50 transition-opacity duration-300 pointer-events-auto"
              style={{ transform: 'translate(-100vw, -100vh)', willChange: 'transform' }}>
              <div className="glowing-cube cube-pink animate-pulse" style={{ animationDelay: '1s' }}>
                  <div className="shine-effect"></div>
              </div>
              <div
                  className="absolute opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-[#1a121d]/90 backdrop-blur-md border border-white/10 p-4 rounded-lg mt-4 w-48 text-sm text-gray-300 left-1/2 -translate-x-1/2 shadow-2xl z-50 text-center pointer-events-none">
                  Global Brain
              </div>
          </div>
      </main>
    </>
  );
}
