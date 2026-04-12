'use client';

import { useState } from 'react';
import { Lock } from 'lucide-react';
import { AuthCard } from './auth-card';
import { FormField } from '@/components/molecules/form-field';
import { SocialAuthRow } from '@/components/molecules/social-auth-row';
import { Button } from '@/components/atoms/button';

type SignupFormProps = {
  onSubmit?: (data: { email: string; password: string; confirmPassword: string }) => void;
  onLogin?: () => void;
  onGoogle?: () => void;
  onFacebook?: () => void;
};

export function SignupForm({ onSubmit, onLogin, onGoogle, onFacebook }: SignupFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit?.({ email, password, confirmPassword });
  }

  return (
    <AuthCard title="Create An Account To Get Started Now!">
      <form onSubmit={handleSubmit} className="space-y-5">
        <FormField
          label="Email"
          inputProps={{
            type: 'email',
            placeholder: 'Email@zibi.com',
            value: email,
            onChange: (e) => setEmail(e.target.value),
            rightElement: <span>@</span>,
            focusVariant: 'pink',
          }}
        />

        <FormField
          label="Password"
          inputProps={{
            type: 'password',
            value: password,
            onChange: (e) => setPassword(e.target.value),
            rightElement: <Lock className="w-4 h-4" />,
            focusVariant: 'pink',
          }}
        />

        <FormField
          label="Confirm Password"
          inputProps={{
            type: 'password',
            value: confirmPassword,
            onChange: (e) => setConfirmPassword(e.target.value),
            rightElement: <Lock className="w-4 h-4" />,
            focusVariant: 'pink',
          }}
        />

        <Button variant="primary-pink" size="md" fullWidth type="submit">
          Sign Up
        </Button>

        <SocialAuthRow label="Or Sign Up with" onGoogle={onGoogle} onFacebook={onFacebook} />

        <div className="text-center mt-8 text-sm">
          <span className="text-brand-pink/80 font-medium">Already Have An Account?</span>
          <button
            type="button"
            onClick={onLogin}
            className="text-white font-semibold hover:underline ml-1"
          >
            Login Now
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
