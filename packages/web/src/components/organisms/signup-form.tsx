'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { AuthCard } from './auth-card';
import { FormField } from '@/components/molecules/form-field';
import { SocialAuthRow } from '@/components/molecules/social-auth-row';
import { Button } from '@/components/atoms/button';

export function SignupForm() {
  const { register } = useAuth();
  const router = useRouter();

  const [email, setEmail]                 = useState('');
  const [password, setPassword]           = useState('');
  const [confirmPassword, setConfirm]     = useState('');
  const [error, setError]                 = useState('');
  const [loading, setLoading]             = useState(false);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    try {
      await register(email, password);
      router.push('/tests');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
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
            onChange: (e) => setConfirm(e.target.value),
            rightElement: <Lock className="w-4 h-4" />,
            focusVariant: 'pink',
          }}
        />

        {error && (
          <p className="text-brand-red text-sm text-center -mt-1">{error}</p>
        )}

        <Button
          variant="primary-pink"
          size="md"
          fullWidth
          type="submit"
          disabled={loading}
        >
          {loading ? 'Creating account…' : 'Sign Up'}
        </Button>

        <SocialAuthRow label="Or Sign Up with" />

        <div className="text-center mt-8 text-sm">
          <span className="text-brand-pink/80 font-medium">Already Have An Account?</span>
          <button
            type="button"
            onClick={() => router.push('/login')}
            className="text-white font-semibold hover:underline ml-1"
          >
            Login Now
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
