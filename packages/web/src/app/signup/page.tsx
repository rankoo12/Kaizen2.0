import { NavBar } from '@/components/molecules/nav-bar';
import { SignupForm } from '@/components/organisms/signup-form';

export default function SignupPage() {
  return (
    <div className="bg-app-bg min-h-screen flex flex-col">
      <NavBar bordered />
      <main className="flex-1 flex items-center justify-center p-4">
        <SignupForm />
      </main>
    </div>
  );
}
