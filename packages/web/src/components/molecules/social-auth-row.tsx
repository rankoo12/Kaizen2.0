import { Divider } from '@/components/atoms/divider';
import { GoogleIcon, FacebookIcon } from '@/components/atoms/social-icons';

type SocialAuthRowProps = {
  label: string;
  onGoogle?: () => void;
  onFacebook?: () => void;
};

export function SocialAuthRow({ label, onGoogle, onFacebook }: SocialAuthRowProps) {
  return (
    <>
      <Divider label={label} />
      <div className="flex items-center space-x-4">
        <button
          type="button"
          onClick={onGoogle}
          className="flex-1 bg-input-bg rounded-lg py-3 flex justify-center hover:bg-white/5 transition-colors"
          aria-label="Continue with Google"
        >
          <GoogleIcon className="w-5 h-5" />
        </button>
        <button
          type="button"
          onClick={onFacebook}
          className="flex-1 bg-input-bg rounded-lg py-3 flex justify-center hover:bg-white/5 transition-colors"
          aria-label="Continue with Facebook"
        >
          <FacebookIcon className="w-5 h-5" />
        </button>
      </div>
    </>
  );
}
