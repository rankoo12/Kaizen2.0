'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { AuthCard } from './auth-card';
import { FormField } from '@/components/molecules/form-field';
import { SocialAuthRow } from '@/components/molecules/social-auth-row';
import { Button } from '@/components/atoms/button';

export function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      const next = searchParams.get('next') ?? '/tests';
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
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

        {error && (
          <p className="text-danger text-sm text-center -mt-2">{error}</p>
        )}

        <Button
          variant="primary-orange"
          size="md"
          fullWidth
          type="submit"
          disabled={loading}
        >
          {loading ? 'Logging in…' : 'Login'}
        </Button>

        <div className="text-center mt-6">
          <button
            type="button"
            className="text-xs text-text-mid hover:text-text-hi transition-colors uppercase tracking-wider font-medium"
          >
            Forgot Password?
          </button>
        </div>

        <SocialAuthRow label="Or Login with" />

        <div className="text-center mt-8 text-sm">
          <span className="text-brand-primary-soft font-medium">Don&apos;t Have An Account?</span>
          <button
            type="button"
            onClick={() => router.push('/signup')}
            className="text-white font-semibold hover:underline ml-1"
          >
            Sign Up Now
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
