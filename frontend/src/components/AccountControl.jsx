// Signed out: "Sign in with GitHub". Signed in: avatar + login opening the account menu
// (My analyses, Sign out). Renders nothing while the session is loading (no flash).
import { lazy, Suspense } from 'react';
import { signIn, useSession } from '../lib/session';
import { Button } from '../ui';
import GitHubMark from './landing/GitHubMark';
import Avatar from './Avatar';

// Radix DropdownMenu stays out of the landing bundle until someone is signed in
const AccountMenu = lazy(() => import('./AccountMenu'));

/**
 * @param {boolean} [props.compact] Shorter sign-in label and no login text (app top bar).
 */
export default function AccountControl({ compact = false, className }) {
  const { status, user } = useSession();

  if (status === 'loading') return null;

  if (status === 'signed_out') {
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => signIn()}
        leadingIcon={<GitHubMark size={16} />}
        className={className}
      >
        {compact ? (
          'Sign in'
        ) : (
          <>
            <span className="sm:hidden">Sign in</span>
            <span className="hidden sm:inline">Sign in with GitHub</span>
          </>
        )}
      </Button>
    );
  }

  return (
    <Suspense fallback={<span className="inline-flex h-8 items-center px-1.5"><Avatar user={user} /></span>}>
      <AccountMenu user={user} compact={compact} className={className} />
    </Suspense>
  );
}
