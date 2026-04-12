import { Brain } from 'lucide-react';
import { Badge } from '@/components/atoms/badge';
import { Button } from '@/components/atoms/button';

type WelcomeHeroProps = {
  onLogin?: () => void;
  onSignUp?: () => void;
};

export function WelcomeHero({ onLogin, onSignUp }: WelcomeHeroProps) {
  return (
    <main className="flex-1 flex flex-col items-center justify-center p-4 relative z-10 -mt-10">
      {/* Background glow layers */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] pointer-events-none">
        <div className="absolute inset-0 bg-purple-900/30 rounded-full blur-[120px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-brand-orange/20 rounded-full blur-[100px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/4 w-[400px] h-[400px] bg-brand-pink/10 rounded-full blur-[90px]" />
      </div>

      <Badge icon={<Brain className="w-3.5 h-3.5" />} variant="pink">
        Neural Architecture V2.4
      </Badge>

      <div className="text-center space-y-2 mt-8">
        <h1 className="text-6xl md:text-7xl font-bold tracking-tight">
          <span className="font-space text-white">KAI</span>
          <span className="font-space text-brand-orange">ZEN</span>
          <span className="font-manrope text-brand-pink">:The QA</span>
        </h1>
        <h1 className="text-6xl md:text-7xl font-bold tracking-tight text-brand-pink font-manrope">
          Brain
        </h1>
      </div>

      <p className="mt-8 text-lg md:text-xl text-gray-300/80 font-light max-w-xl text-center">
        Autonomous QA testing that actually understands
        <br />
        your interface
      </p>

      <div className="mt-12 flex flex-col items-center space-y-4 w-full max-w-[320px]">
        <Button variant="outline-orange" size="lg" fullWidth onClick={onLogin}>
          Login
        </Button>
        <Button variant="primary-pink" size="lg" fullWidth onClick={onSignUp}>
          Sign Up
        </Button>
      </div>
    </main>
  );
}
