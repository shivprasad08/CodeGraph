// Signed-in account menu (avatar + login): My analyses, Sign out. Lazy-loaded by
// AccountControl so the landing bundle does not pull in Radix DropdownMenu.
import { useNavigate } from 'react-router-dom';
import { ChevronDown, History, LogOut } from 'lucide-react';
import { cn } from '../lib/cn';
import { signOutAndForget } from '../lib/session';
import { focusRing } from '../ui';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu';
import Avatar from './Avatar';

const icon = { size: 16, strokeWidth: 1.5, 'aria-hidden': true };

export default function AccountMenu({ user, compact = false, className }) {
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account: ${user.login}`}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-cg-control px-1.5 text-cg-sm text-cg-text hover:bg-cg-hover',
            '[@media(pointer:coarse)]:min-h-11',
            focusRing,
            className,
          )}
        >
          <Avatar user={user} />
          {!compact && <span className="hidden max-w-[140px] truncate sm:inline">{user.login}</span>}
          <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" className="text-cg-tertiary" />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <div className="px-2 pb-1.5 pt-1 text-cg-xs text-cg-tertiary">
          Signed in as <span className="text-cg-secondary">@{user.login}</span>
        </div>
        <MenuSeparator />
        <MenuItem icon={<History {...icon} />} onSelect={() => navigate('/analyses')}>
          My analyses
        </MenuItem>
        <MenuItem
          icon={<LogOut {...icon} />}
          onSelect={async () => {
            await signOutAndForget().catch(() => {});
            navigate('/');
          }}
        >
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
