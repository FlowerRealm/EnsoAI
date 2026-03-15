import type { RemoteWindowSession } from '@shared/types';
import { PlugZap, Shuffle } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../ui/menu';

interface RemoteHostSidebarCardProps {
  remoteSession?: RemoteWindowSession | null;
  onConnect: () => void;
  onSwitchHost?: () => void;
  onDisconnect?: () => void;
}

export function RemoteHostSidebarCard({
  remoteSession = null,
  onConnect,
  onSwitchHost,
  onDisconnect,
}: RemoteHostSidebarCardProps) {
  const { t } = useI18n();

  if (!remoteSession) {
    return (
      <button
        type="button"
        onClick={onConnect}
        className={cn(
          'flex h-8 items-center rounded-full border px-3 text-sm no-drag',
          'text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground'
        )}
        title={t('Connect to Remote Host')}
      >
        <span>{t('Local')}</span>
      </button>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className={cn(
              'flex h-8 items-center rounded-full border px-3 text-sm no-drag',
              'border-primary/20 bg-primary/6 text-foreground transition-colors hover:bg-primary/10'
            )}
            title={t('Connected')}
          >
            <span className="font-medium">{t('Remote')}</span>
          </button>
        }
      />
      <MenuPopup align="start" sideOffset={8} className="min-w-[220px]">
        <div className="px-2 py-1.5">
          <div className="truncate font-medium text-sm">{remoteSession.profileName}</div>
          <div className="truncate text-muted-foreground text-xs">{remoteSession.sshTarget}</div>
        </div>
        <MenuSeparator />
        <MenuItem onClick={onSwitchHost} disabled={!onSwitchHost}>
          <Shuffle className="h-4 w-4" />
          {t('Switch Host')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={onDisconnect} disabled={!onDisconnect}>
          <PlugZap className="h-4 w-4" />
          {t('Disconnect')}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
