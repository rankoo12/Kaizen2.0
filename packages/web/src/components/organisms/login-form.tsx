'use client';

import { useState } from 'react';
import { Lock } from 'lucide-react';
import { AuthCard } from './auth-card';
import { FormField } from '@/components/molecules/form-field';
import { SocialAuthRow } from '@/components/molecules/social-auth-row';
import { Button } from '@/components/atoms/button';

type LoginFormProps = {
  onSubmit?: (data: { email: string; password: string }) => void;
  onForgotPassword?: () => void;
  onSignUp?: () => void;
  onGoogle?: () => void;
  onFacebook?: () => void;
};

export function LoginForm({ onSubmit, onForgotPassword, onSignUp, onGoogle, onFacebook }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit?.({ email, password });
  }

  return (
    <AuthCard title="Welcome Back!">
      <form onSubmit={handleSubmit} className="space-y-6">
        <FormField
          label="Email"
          inputProps={{
            type: 'email',
            placeholder: 'Email@zibi.com',
            value: email,
            onChange: (e) => setEmail(e.target.value),
            rightElement: <span>@</span>,
            focusVariant: 'orange',
          }}
        />

        <FormField
          label="Password"
          inputProps={{
            type: 'password',
            value: password,
            onChange: (e) => setPassword(e.target.value),
            rightElement: <Lock className="w-4 h-4" />,
            focusVariant: 'orange',
          }}
        />

        <Button variant="primary-orange" size="md" fullWidth type="submit">
          Login
        </Button>

        <div className="text-center mt-6">
          <button
            type="button"
            onClick={onForgotPassword}
            className="text-xs text-gray-400 hover:text-white transition-colors uppercase tracking-wider font-medium"
          >
            Forgot Password?
          </button>
        </div>

        <SocialAuthRow label="Or Login with" onGoogle={onGoogle} onFacebook={onFacebook} />

        <div className="text-center mt-8 text-sm">
          <span className="text-brand-orange-light font-medium">Don&apos;t Have An Account?</span>
          <button
            type="button"
            onClick={onSignUp}
            className="text-white font-semibold hover:underline ml-1"
          >
            Sign Up Now
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
