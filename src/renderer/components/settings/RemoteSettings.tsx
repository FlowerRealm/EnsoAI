import type {
  ConnectionProfile,
  ConnectionTestResult,
  RemoteHelperStatus,
  RemotePlatform,
} from '@shared/types';
import {
  Download,
  Loader2,
  RefreshCw,
  RotateCw,
  Save,
  Server,
  TestTube2,
  Trash2,
} from 'lucide-react';
import * as React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

type PlatformSelectValue = '' | RemotePlatform;

interface RemoteProfileFormState {
  name: string;
  sshTarget: string;
  helperInstallDir: string;
  platformHint: PlatformSelectValue;
}

const EMPTY_FORM: RemoteProfileFormState = {
  name: '',
  sshTarget: '',
  helperInstallDir: '',
  platformHint: '',
};

function getPlatformLabel(
  value: PlatformSelectValue | RemotePlatform | undefined,
  t: (key: string) => string
) {
  if (value === 'linux') return 'Linux';
  if (value === 'darwin') return 'macOS';
  if (value === 'win32') return 'Windows';
  return t('Auto detect');
}

export function RemoteSettings() {
  const { t } = useI18n();
  const profiles = useSettingsStore((state) => state.remoteSettings.profiles);
  const setRemoteProfiles = useSettingsStore((state) => state.setRemoteProfiles);
  const upsertRemoteProfile = useSettingsStore((state) => state.upsertRemoteProfile);
  const removeRemoteProfile = useSettingsStore((state) => state.removeRemoteProfile);

  const [selectedProfileId, setSelectedProfileId] = React.useState('');
  const [form, setForm] = React.useState<RemoteProfileFormState>(EMPTY_FORM);
  const [isLoading, setIsLoading] = React.useState(true);
  const [busyAction, setBusyAction] = React.useState<
    | 'refresh'
    | 'save'
    | 'test'
    | 'delete'
    | 'helper-status'
    | 'helper-install'
    | 'helper-update'
    | 'helper-delete'
    | null
  >(null);
  const [feedback, setFeedback] = React.useState<{
    variant: 'error' | 'success' | 'info';
    title: string;
    description: string;
  } | null>(null);
  const [testResult, setTestResult] = React.useState<ConnectionTestResult | null>(null);
  const [helperStatus, setHelperStatus] = React.useState<RemoteHelperStatus | null>(null);
  const [deleteHelperDialogOpen, setDeleteHelperDialogOpen] = React.useState(false);
  const selectedProfile = profiles.find((item) => item.id === selectedProfileId);

  const syncFormFromProfile = React.useCallback((profile?: ConnectionProfile | null) => {
    if (!profile) {
      setForm(EMPTY_FORM);
      return;
    }

    setForm({
      name: profile.name,
      sshTarget: profile.sshTarget,
      helperInstallDir: profile.helperInstallDir ?? '',
      platformHint: profile.platformHint ?? '',
    });
  }, []);

  const loadProfiles = React.useCallback(async () => {
    setBusyAction((current) => current ?? 'refresh');
    try {
      const nextProfiles = await window.electronAPI.remote.listProfiles();
      setRemoteProfiles(nextProfiles);
      if (selectedProfileId && !nextProfiles.some((item) => item.id === selectedProfileId)) {
        setSelectedProfileId('');
        syncFormFromProfile(null);
      }
      setFeedback(null);
    } catch (error) {
      setFeedback({
        variant: 'error',
        title: t('Failed to load remote profiles'),
        description: error instanceof Error ? error.message : t('Unknown error'),
      });
    } finally {
      setBusyAction(null);
      setIsLoading(false);
    }
  }, [selectedProfileId, setRemoteProfiles, syncFormFromProfile, t]);

  React.useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  React.useEffect(() => {
    const profile = profiles.find((item) => item.id === selectedProfileId);
    syncFormFromProfile(profile);
    setTestResult(null);
    setHelperStatus(null);
  }, [profiles, selectedProfileId, syncFormFromProfile]);

  const loadHelperStatus = React.useCallback(
    async (profileId: string, mode: 'refresh' | 'silent' = 'refresh') => {
      if (!profileId) {
        setHelperStatus(null);
        return null;
      }

      if (mode === 'refresh') {
        setBusyAction('helper-status');
      }

      try {
        const status = await window.electronAPI.remote.getHelperStatus(profileId);
        setHelperStatus(status);
        return status;
      } catch (error) {
        setHelperStatus(null);
        if (mode === 'refresh') {
          setFeedback({
            variant: 'error',
            title: t('Failed to refresh helper status'),
            description: error instanceof Error ? error.message : t('Unknown error'),
          });
        }
        return null;
      } finally {
        if (mode === 'refresh') {
          setBusyAction(null);
        }
      }
    },
    [t]
  );

  React.useEffect(() => {
    if (!selectedProfileId) {
      setHelperStatus(null);
      return;
    }
    void loadHelperStatus(selectedProfileId, 'silent');
  }, [loadHelperStatus, selectedProfileId]);

  const buildDraftProfile = React.useCallback((): ConnectionProfile => {
    const now = Date.now();
    return {
      id: selectedProfileId || 'draft-profile',
      name: form.name.trim(),
      sshTarget: form.sshTarget.trim(),
      helperInstallDir: form.helperInstallDir.trim() || undefined,
      platformHint: form.platformHint || undefined,
      createdAt: now,
      updatedAt: now,
    };
  }, [form, selectedProfileId]);

  const handleSave = React.useCallback(async () => {
    if (!form.name.trim()) {
      setFeedback({
        variant: 'error',
        title: t('Profile name is required'),
        description: t('Give this connection a short recognizable name.'),
      });
      return;
    }

    if (!form.sshTarget.trim()) {
      setFeedback({
        variant: 'error',
        title: t('SSH target is required'),
        description: t('Use the same target you would pass to ssh, for example user@example.com.'),
      });
      return;
    }

    setBusyAction('save');
    try {
      const savedProfile = await window.electronAPI.remote.saveProfile({
        id: selectedProfileId || undefined,
        name: form.name.trim(),
        sshTarget: form.sshTarget.trim(),
        helperInstallDir: form.helperInstallDir.trim() || undefined,
        platformHint: form.platformHint || undefined,
      });
      upsertRemoteProfile(savedProfile);
      setSelectedProfileId(savedProfile.id);
      setFeedback({
        variant: 'success',
        title: t('Remote profile saved'),
        description: t('You can now use it from Add Repository > SSH.'),
      });
      await loadProfiles();
      await loadHelperStatus(savedProfile.id, 'silent');
    } catch (error) {
      setFeedback({
        variant: 'error',
        title: t('Failed to save remote profile'),
        description: error instanceof Error ? error.message : t('Unknown error'),
      });
    } finally {
      setBusyAction(null);
    }
  }, [form, loadHelperStatus, loadProfiles, selectedProfileId, t, upsertRemoteProfile]);

  const handleDelete = React.useCallback(async () => {
    if (!selectedProfileId) return;
    setBusyAction('delete');
    try {
      await window.electronAPI.remote.deleteProfile(selectedProfileId);
      removeRemoteProfile(selectedProfileId);
      setSelectedProfileId('');
      syncFormFromProfile(null);
      setTestResult(null);
      setHelperStatus(null);
      setFeedback({
        variant: 'success',
        title: t('Remote profile deleted'),
        description: t('The saved SSH connection has been removed.'),
      });
      await loadProfiles();
    } catch (error) {
      setFeedback({
        variant: 'error',
        title: t('Failed to delete remote profile'),
        description: error instanceof Error ? error.message : t('Unknown error'),
      });
    } finally {
      setBusyAction(null);
    }
  }, [loadProfiles, removeRemoteProfile, selectedProfileId, syncFormFromProfile, t]);

  const handleTest = React.useCallback(async () => {
    const draftProfile = buildDraftProfile();
    if (!draftProfile.name || !draftProfile.sshTarget) {
      setFeedback({
        variant: 'error',
        title: t('Profile is incomplete'),
        description: t('Fill in the profile name and SSH target before testing the connection.'),
      });
      return;
    }

    setBusyAction('test');
    try {
      const result = await window.electronAPI.remote.testConnection(draftProfile);
      setTestResult(result);
      if (result.success) {
        setFeedback({
          variant: 'success',
          title: t('Connection succeeded'),
          description: t('The remote host is reachable and ready for Enso remote helper setup.'),
        });
      } else {
        setFeedback({
          variant: 'error',
          title: t('Connection failed'),
          description: result.error || t('Unknown error'),
        });
      }
    } catch (error) {
      setFeedback({
        variant: 'error',
        title: t('Connection failed'),
        description: error instanceof Error ? error.message : t('Unknown error'),
      });
    } finally {
      setBusyAction(null);
    }
  }, [buildDraftProfile, t]);

  const runHelperAction = React.useCallback(
    async (
      action: 'install' | 'update' | 'delete',
      onSuccess: () => { title: string; description: string }
    ) => {
      if (!selectedProfileId) return;

      setBusyAction(
        action === 'install'
          ? 'helper-install'
          : action === 'update'
            ? 'helper-update'
            : 'helper-delete'
      );

      try {
        const nextStatus =
          action === 'install'
            ? await window.electronAPI.remote.installHelper(selectedProfileId)
            : action === 'update'
              ? await window.electronAPI.remote.updateHelper(selectedProfileId)
              : await window.electronAPI.remote.deleteHelper(selectedProfileId);
        setHelperStatus(nextStatus);
        const message = onSuccess();
        setFeedback({
          variant: 'success',
          title: message.title,
          description: message.description,
        });
      } catch (error) {
        setFeedback({
          variant: 'error',
          title:
            action === 'install'
              ? t('Failed to install helper')
              : action === 'update'
                ? t('Failed to update helper')
                : t('Failed to delete helper'),
          description: error instanceof Error ? error.message : t('Unknown error'),
        });
      } finally {
        setBusyAction(null);
      }
    },
    [selectedProfileId, t]
  );

  const handleInstallHelper = React.useCallback(async () => {
    await runHelperAction('install', () => ({
      title: t('Helper installed'),
      description: t('The current remote helper version is now installed.'),
    }));
  }, [runHelperAction, t]);

  const handleUpdateHelper = React.useCallback(async () => {
    await runHelperAction('update', () => ({
      title: t('Helper updated'),
      description: t('The current remote helper version was reinstalled successfully.'),
    }));
  }, [runHelperAction, t]);

  const handleDeleteHelper = React.useCallback(async () => {
    setDeleteHelperDialogOpen(false);
    await runHelperAction('delete', () => ({
      title: t('Helper deleted'),
      description: t('All installed helper versions for this profile were removed.'),
    }));
  }, [runHelperAction, t]);

  const environmentItems = React.useMemo(
    () =>
      testResult?.success
        ? [
            {
              label: t('Platform'),
              value: testResult.platform ? getPlatformLabel(testResult.platform, t) : '-',
            },
            { label: t('Home directory'), value: testResult.homeDir || '-' },
            { label: t('Node'), value: testResult.nodeVersion || '-' },
            { label: t('Git'), value: testResult.gitVersion || '-' },
          ]
        : [],
    [t, testResult]
  );

  const helperInfoItems = React.useMemo(
    () =>
      helperStatus
        ? [
            {
              label: t('Status'),
              value: helperStatus.installed ? t('Installed') : t('Not installed'),
            },
            { label: t('Current version'), value: helperStatus.currentVersion },
            { label: t('Install directory'), value: helperStatus.installDir },
            {
              label: t('Installed versions'),
              value:
                helperStatus.installedVersions.length > 0
                  ? helperStatus.installedVersions.join(', ')
                  : '-',
            },
            {
              label: t('Connection'),
              value: helperStatus.connected ? t('Connected') : t('Disconnected'),
            },
          ]
        : [],
    [helperStatus, t]
  );

  const helperBusy =
    busyAction === 'helper-status' ||
    busyAction === 'helper-install' ||
    busyAction === 'helper-update' ||
    busyAction === 'helper-delete';
  const hasSelectedProfile = Boolean(selectedProfileId);
  const helperInstalled = helperStatus?.installed ?? false;
  const currentVersionInstalled =
    helperStatus?.installedVersions.includes(helperStatus.currentVersion) ?? false;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="font-semibold text-xl">{t('Remote Connection')}</h2>
        <p className="text-muted-foreground text-sm">
          {t('Save SSH profiles here, then add a remote workspace from the Add Repository dialog.')}
        </p>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t('SSH Profiles')}</CardTitle>
          <CardDescription>
            {t('These profiles reuse your existing SSH configuration and credentials.')}
          </CardDescription>
        </CardHeader>
        <CardPanel className="space-y-6">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_248px] xl:items-end">
            <Field className="min-w-0">
              <FieldLabel>{t('Profile')}</FieldLabel>
              <Select
                value={selectedProfileId}
                onValueChange={(value) => setSelectedProfileId(value ?? '')}
              >
                <SelectTrigger className="min-w-0">
                  <SelectValue>
                    {selectedProfileId
                      ? selectedProfile?.name || t('Unknown profile')
                      : t('Create new profile')}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="">{t('Create new profile')}</SelectItem>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <FieldDescription>
                {profiles.length === 0
                  ? t('No profiles saved yet.')
                  : t('{{count}} saved profiles', { count: profiles.length })}
              </FieldDescription>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <Button
                type="button"
                variant="outline"
                className="w-full justify-center"
                onClick={() => {
                  setSelectedProfileId('');
                  syncFormFromProfile(null);
                  setFeedback(null);
                  setTestResult(null);
                  setHelperStatus(null);
                }}
              >
                <Server className="h-4 w-4 shrink-0" />
                <span>{t('New')}</span>
              </Button>

              <Button
                type="button"
                variant="outline"
                className="w-full justify-center"
                onClick={() => void loadProfiles()}
              >
                {busyAction === 'refresh' || isLoading ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 shrink-0" />
                )}
                <span>{t('Refresh')}</span>
              </Button>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Field className="min-w-0">
              <FieldLabel>{t('Profile name')}</FieldLabel>
              <Input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder={t('My staging server')}
              />
            </Field>

            <Field className="min-w-0">
              <FieldLabel>{t('SSH target')}</FieldLabel>
              <Input
                value={form.sshTarget}
                onChange={(event) =>
                  setForm((current) => ({ ...current, sshTarget: event.target.value }))
                }
                placeholder="user@example.com"
              />
              <FieldDescription>
                {t('Use the same target string you would pass to the ssh command.')}
              </FieldDescription>
            </Field>

            <Field className="min-w-0">
              <FieldLabel>{t('Helper install directory')}</FieldLabel>
              <Input
                value={form.helperInstallDir}
                onChange={(event) =>
                  setForm((current) => ({ ...current, helperInstallDir: event.target.value }))
                }
                placeholder={t('Optional override, for example ~/.ensoai/remote-helper')}
              />
            </Field>

            <Field className="min-w-0">
              <FieldLabel>{t('Platform hint')}</FieldLabel>
              <Select
                value={form.platformHint}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    platformHint: (value as PlatformSelectValue) || '',
                  }))
                }
              >
                <SelectTrigger className="min-w-0">
                  <SelectValue>{getPlatformLabel(form.platformHint, t)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="">{t('Auto detect')}</SelectItem>
                  <SelectItem value="linux">Linux</SelectItem>
                  <SelectItem value="darwin">macOS</SelectItem>
                  <SelectItem value="win32">Windows</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Button
              type="button"
              className="w-full justify-center"
              onClick={() => void handleSave()}
            >
              {busyAction === 'save' ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              ) : (
                <Save className="h-4 w-4 shrink-0" />
              )}
              <span>{t('Save profile')}</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              className="w-full justify-center"
              onClick={() => void handleTest()}
            >
              {busyAction === 'test' ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              ) : (
                <TestTube2 className="h-4 w-4 shrink-0" />
              )}
              <span>{t('Test connection')}</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              className="w-full justify-center"
              onClick={() => void handleDelete()}
              disabled={!selectedProfileId}
            >
              {busyAction === 'delete' ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 shrink-0" />
              )}
              <span>{t('Delete profile')}</span>
            </Button>
          </div>
        </CardPanel>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t('Remote Helper')}</CardTitle>
          <CardDescription>
            {t('Install, refresh, update, or remove the helper on the selected remote host.')}
          </CardDescription>
        </CardHeader>
        <CardPanel className="space-y-6">
          {!hasSelectedProfile ? (
            <Alert variant="info">
              <AlertTitle>{t('Select a profile')}</AlertTitle>
              <AlertDescription>
                {t('Choose a saved SSH profile above before managing the remote helper.')}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {helperStatus?.error && (
                <Alert variant="error">
                  <AlertTitle>{t('Failed to refresh helper status')}</AlertTitle>
                  <AlertDescription>{helperStatus.error}</AlertDescription>
                </Alert>
              )}

              {helperStatus && (
                <Alert variant="info">
                  <AlertTitle>{t('Helper status')}</AlertTitle>
                  <AlertDescription className="grid gap-3 sm:grid-cols-2">
                    {helperInfoItems.map((item) => (
                      <div
                        key={item.label}
                        className="min-w-0 rounded-lg bg-background/70 px-3 py-2"
                      >
                        <div className="text-muted-foreground text-xs">{item.label}</div>
                        <div className="mt-1 break-all font-medium text-foreground text-sm">
                          {item.value}
                        </div>
                      </div>
                    ))}
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-center"
                  onClick={() => void loadHelperStatus(selectedProfileId)}
                  disabled={!hasSelectedProfile || helperBusy}
                >
                  {busyAction === 'helper-status' ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 shrink-0" />
                  )}
                  <span>{t('Refresh status')}</span>
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-center"
                  onClick={() => void handleInstallHelper()}
                  disabled={!hasSelectedProfile || helperBusy || currentVersionInstalled}
                >
                  {busyAction === 'helper-install' ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 shrink-0" />
                  )}
                  <span>{t('Install')}</span>
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-center"
                  onClick={() => void handleUpdateHelper()}
                  disabled={!hasSelectedProfile || helperBusy || !helperInstalled}
                >
                  {busyAction === 'helper-update' ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <RotateCw className="h-4 w-4 shrink-0" />
                  )}
                  <span>{t('Update')}</span>
                </Button>

                <Button
                  type="button"
                  variant="destructive-outline"
                  className="w-full justify-center"
                  onClick={() => setDeleteHelperDialogOpen(true)}
                  disabled={!hasSelectedProfile || helperBusy || !helperInstalled}
                >
                  {busyAction === 'helper-delete' ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 shrink-0" />
                  )}
                  <span>{t('Delete helper')}</span>
                </Button>
              </div>
            </>
          )}
        </CardPanel>
      </Card>

      {feedback && (
        <Alert variant={feedback.variant}>
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.description}</AlertDescription>
        </Alert>
      )}

      {testResult?.success && (
        <Alert variant="info">
          <AlertTitle>{t('Remote environment')}</AlertTitle>
          <AlertDescription className="grid gap-3 sm:grid-cols-2">
            {environmentItems.map((item) => (
              <div key={item.label} className="min-w-0 rounded-lg bg-background/70 px-3 py-2">
                <div className="text-muted-foreground text-xs">{item.label}</div>
                <div className="mt-1 break-all font-medium text-foreground text-sm">
                  {item.value}
                </div>
              </div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <AlertDialog open={deleteHelperDialogOpen} onOpenChange={setDeleteHelperDialogOpen}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Delete remote helper?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('This will remove all installed helper versions for this SSH profile.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">{t('Cancel')}</Button>} />
            <Button variant="destructive" onClick={() => void handleDeleteHelper()}>
              {t('Delete helper')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
