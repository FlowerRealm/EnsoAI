import type {
  CloneProgress,
  FileEntry,
  RecentEditorProject,
  RemoteWindowOpenTarget,
  RemoteWindowSession,
  ValidateLocalPathResult,
} from '@shared/types';
import {
  ArrowUp,
  ChevronRight,
  FolderOpen,
  Globe,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { matchSorter } from 'match-sorter';
import * as React from 'react';
import type { RepositoryGroup } from '@/App/constants';
import { CreateGroupDialog } from '@/components/group';
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from '@/components/ui/autocomplete';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { useCloneTasksStore } from '@/stores/cloneTasks';
import { useSettingsStore } from '@/stores/settings';

type AddMode = 'local' | 'remote' | 'ssh';
export type AddRepositoryDialogVariant =
  | 'add-repository'
  | 'connect-remote-host'
  | 'add-remote-project';

interface AddRepositoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: RepositoryGroup[];
  defaultGroupId: string | null;
  variant?: AddRepositoryDialogVariant;
  remoteSession?: RemoteWindowSession | null;
  onAddLocal: (path: string, groupId: string | null) => void;
  onCloneComplete: (path: string, groupId: string | null) => void;
  onAddRemote: (path: string, groupId: string | null, connectionId: string) => Promise<void> | void;
  onOpenRemoteHost: (
    connectionId: string,
    target: RemoteWindowOpenTarget
  ) => Promise<boolean> | boolean;
  onCreateGroup: (name: string, emoji: string, color: string) => RepositoryGroup;
  /** Pre-filled local path (e.g., from drag-and-drop) */
  initialLocalPath?: string;
  /** Callback to clear the initial local path after it's been used */
  onClearInitialLocalPath?: () => void;
}

export function AddRepositoryDialog({
  open,
  onOpenChange,
  groups,
  defaultGroupId,
  variant = 'add-repository',
  remoteSession = null,
  onAddLocal,
  onCloneComplete,
  onAddRemote,
  onOpenRemoteHost,
  onCreateGroup,
  initialLocalPath,
  onClearInitialLocalPath,
}: AddRepositoryDialogProps) {
  const { t } = useI18n();
  const hideGroups = useSettingsStore((s) => s.hideGroups);
  const remoteProfiles = useSettingsStore((s) => s.remoteSettings.profiles);
  const setRemoteProfiles = useSettingsStore((s) => s.setRemoteProfiles);
  const dialogVariant = variant;
  const activeRemoteSession = dialogVariant === 'add-remote-project' ? remoteSession : null;
  const defaultMode: AddMode = dialogVariant === 'add-repository' ? 'local' : 'ssh';
  const showTabs = dialogVariant === 'add-repository';

  // Progress stage display labels (使用 t() 支持国际化，useMemo 避免重复创建)
  const stageLabels = React.useMemo<Record<string, string>>(
    () => ({
      counting: t('Counting objects...'),
      compressing: t('Compressing objects...'),
      receiving: t('Receiving objects...'),
      resolving: t('Resolving deltas...'),
    }),
    [t]
  );
  const [mode, setMode] = React.useState<AddMode>(defaultMode);

  React.useEffect(() => {
    if (open) {
      setMode(defaultMode);
    }
  }, [defaultMode, open]);

  // Group selection state ('' = no group)
  const [selectedGroupId, setSelectedGroupId] = React.useState<string>('');
  const prevOpenRef = React.useRef(open);
  const prevDefaultGroupIdRef = React.useRef<string | null>(defaultGroupId);
  const groupSelectionTouchedRef = React.useRef(false);

  React.useEffect(() => {
    const wasOpen = prevOpenRef.current;
    const prevDefaultGroupId = prevDefaultGroupIdRef.current;

    if (!wasOpen && open) {
      groupSelectionTouchedRef.current = false;
      setSelectedGroupId(defaultGroupId || '');
      setMode(defaultMode);
    } else if (
      open &&
      !groupSelectionTouchedRef.current &&
      selectedGroupId === (prevDefaultGroupId || '')
    ) {
      setSelectedGroupId(defaultGroupId || '');
    }

    prevOpenRef.current = open;
    prevDefaultGroupIdRef.current = defaultGroupId;
  }, [defaultGroupId, defaultMode, open, selectedGroupId]);

  // Handle initial local path from drag-and-drop
  React.useEffect(() => {
    if (open && initialLocalPath && dialogVariant === 'add-repository') {
      setMode('local');
      setLocalPath(initialLocalPath);
      onClearInitialLocalPath?.();
    }
  }, [dialogVariant, open, initialLocalPath, onClearInitialLocalPath]);

  React.useEffect(() => {
    if (!open || !activeRemoteSession) {
      return;
    }
    setMode('ssh');
    setSshProfileId(activeRemoteSession.connectionId);
  }, [activeRemoteSession, open]);

  // Local mode state
  const [localPath, setLocalPath] = React.useState('');
  const [recentProjects, setRecentProjects] = React.useState<RecentEditorProject[]>([]);
  const [pathValidation, setPathValidation] = React.useState<ValidateLocalPathResult | null>(null);
  const [isValidating, setIsValidating] = React.useState(false);

  // Remote mode state
  const [remoteUrl, setRemoteUrl] = React.useState('');
  const [targetDir, setTargetDir] = React.useState('');
  const [repoName, setRepoName] = React.useState('');
  const [isValidUrl, setIsValidUrl] = React.useState(false);

  // SSH remote host / remote project mode state
  const [sshProfileId, setSshProfileId] = React.useState('');
  const [sshRepoPath, setSshRepoPath] = React.useState('');
  const [sshRoots, setSshRoots] = React.useState<string[]>([]);
  const [sshEntries, setSshEntries] = React.useState<FileEntry[]>([]);
  const [sshBrowserPath, setSshBrowserPath] = React.useState('');
  const [isLoadingProfiles, setIsLoadingProfiles] = React.useState(false);
  const [isLoadingRoots, setIsLoadingRoots] = React.useState(false);
  const [isLoadingEntries, setIsLoadingEntries] = React.useState(false);
  const [isConnectingRemote, setIsConnectingRemote] = React.useState(false);
  const [remoteDirectoryDialogOpen, setRemoteDirectoryDialogOpen] = React.useState(false);
  const [sshOpenTarget, setSshOpenTarget] =
    React.useState<RemoteWindowOpenTarget>('current-window');

  // Clone progress state
  const [isCloning, setIsCloning] = React.useState(false);
  const [cloneProgress, setCloneProgress] = React.useState<CloneProgress | null>(null);
  const [cloneTaskId, setCloneTaskId] = React.useState<string | null>(null);

  // Clone tasks store
  const addCloneTask = useCloneTasksStore((s) => s.addTask);
  const completeCloneTask = useCloneTasksStore((s) => s.completeTask);
  const failCloneTask = useCloneTasksStore((s) => s.failTask);
  const activeTaskProgress = useCloneTasksStore((s) => {
    if (!cloneTaskId) return null;
    const task = s.tasks.find((t) => t.id === cloneTaskId);
    return task?.progress ?? null;
  });

  // Error state
  const [error, setError] = React.useState<string | null>(null);

  // Create group dialog state
  const [createGroupDialogOpen, setCreateGroupDialogOpen] = React.useState(false);

  const normalizeRemotePathInput = React.useCallback((value: string) => {
    const trimmed = value.trim().replace(/\\/g, '/');
    if (!trimmed) return '';
    if (trimmed === '/') return '/';
    if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`;
    const normalized = trimmed.replace(/\/+$/, '');
    return normalized || '/';
  }, []);

  const getRemoteParentPath = React.useCallback(
    (value: string) => {
      const normalized = normalizeRemotePathInput(value);
      if (!normalized || normalized === '/') {
        return null;
      }
      if (/^[A-Za-z]:\/?$/.test(normalized)) {
        return null;
      }

      const withoutTrailingSlash =
        normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
      const lastSlashIndex = withoutTrailingSlash.lastIndexOf('/');
      if (lastSlashIndex < 0) {
        return null;
      }
      if (/^[A-Za-z]:/.test(withoutTrailingSlash) && lastSlashIndex === 2) {
        return `${withoutTrailingSlash.slice(0, 2)}/`;
      }
      if (lastSlashIndex === 0) {
        return '/';
      }
      return withoutTrailingSlash.slice(0, lastSlashIndex);
    },
    [normalizeRemotePathInput]
  );

  const loadSshDirectory = React.useCallback(
    async (profileId: string, remotePath: string) => {
      const normalizedPath = normalizeRemotePathInput(remotePath);
      if (!normalizedPath) {
        setSshEntries([]);
        return;
      }

      setIsLoadingEntries(true);
      try {
        const entries = await window.electronAPI.remote.listDirectory(profileId, normalizedPath);
        setSshEntries(entries.filter((entry) => entry.isDirectory));
        setError(null);
      } catch (err) {
        setSshEntries([]);
        setError(
          err instanceof Error ? err.message : t('Failed to browse remote host directories')
        );
      } finally {
        setIsLoadingEntries(false);
      }
    },
    [normalizeRemotePathInput, t]
  );

  // Validate URL and extract repo name when URL changes
  React.useEffect(() => {
    if (!remoteUrl.trim()) {
      setIsValidUrl(false);
      setRepoName('');
      return;
    }

    const validateUrl = async () => {
      try {
        const result = await window.electronAPI.git.validateUrl(remoteUrl.trim());
        setIsValidUrl(result.valid);
        if (result.valid && result.repoName) {
          setRepoName(result.repoName);
        }
      } catch {
        setIsValidUrl(false);
      }
    };

    // Debounce validation
    const timer = setTimeout(validateUrl, 300);
    return () => clearTimeout(timer);
  }, [remoteUrl]);

  // Sync progress from store to local state for UI display
  React.useEffect(() => {
    if (activeTaskProgress) {
      setCloneProgress(activeTaskProgress);
    }
  }, [activeTaskProgress]);

  // Load recent projects when dialog opens
  React.useEffect(() => {
    if (open) {
      window.electronAPI.appDetector
        .getRecentProjects()
        .then(setRecentProjects)
        .catch(() => setRecentProjects([]));
    }
  }, [open]);

  React.useEffect(() => {
    if (!open || dialogVariant !== 'connect-remote-host') return;

    setIsLoadingProfiles(true);
    window.electronAPI.remote
      .listProfiles()
      .then((profiles) => {
        setRemoteProfiles(profiles);
        if (profiles.length > 0 && !profiles.some((profile) => profile.id === sshProfileId)) {
          setSshProfileId(profiles[0].id);
        }
      })
      .catch(() => {
        setRemoteProfiles([]);
        setSshProfileId('');
      })
      .finally(() => {
        setIsLoadingProfiles(false);
      });
  }, [dialogVariant, open, setRemoteProfiles, sshProfileId]);

  React.useEffect(() => {
    if (!open || !sshProfileId || !activeRemoteSession) {
      setSshRoots([]);
      setSshEntries([]);
      setSshBrowserPath('');
      return;
    }

    setIsLoadingRoots(true);
    window.electronAPI.remote
      .browseRoots(sshProfileId)
      .then((roots) => {
        setSshRoots(roots);
        const initialPath = normalizeRemotePathInput(roots[roots.length - 1] || roots[0] || '');
        setSshBrowserPath(initialPath);
        setError(null);
      })
      .catch((error) => {
        setSshRoots([]);
        setSshEntries([]);
        setSshBrowserPath('');
        setError(error instanceof Error ? error.message : t('Failed to browse remote roots'));
      })
      .finally(() => {
        setIsLoadingRoots(false);
      });
  }, [activeRemoteSession, open, sshProfileId, normalizeRemotePathInput, t]);

  React.useEffect(() => {
    if (!open || !sshProfileId || !sshBrowserPath) {
      setSshEntries([]);
      return;
    }

    void loadSshDirectory(sshProfileId, sshBrowserPath);
  }, [open, sshProfileId, sshBrowserPath, loadSshDirectory]);

  // Debounced path validation (300ms, matching URL validation)
  React.useEffect(() => {
    if (!localPath.trim()) {
      setPathValidation(null);
      setIsValidating(false);
      return;
    }

    setIsValidating(true);

    const timer = setTimeout(async () => {
      try {
        const result = await window.electronAPI.git.validateLocalPath(localPath.trim());
        setPathValidation(result);
      } catch {
        setPathValidation(null);
      } finally {
        setIsValidating(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [localPath]);

  // Filter function for autocomplete - fuzzy match path
  const filterProject = React.useCallback((project: RecentEditorProject, query: string) => {
    if (!query) return true;
    const results = matchSorter([project.path], query, {
      threshold: matchSorter.rankings.CONTAINS,
    });
    return results.length > 0;
  }, []);

  // Format path for display - replace home directory with ~
  const formatPathDisplay = React.useCallback((fullPath: string) => {
    const home = window.electronAPI.env.HOME;
    if (home && fullPath.startsWith(home)) {
      return `~${fullPath.slice(home.length)}`;
    }
    return fullPath;
  }, []);

  const handleSelectLocalPath = async () => {
    try {
      const selectedPath = await window.electronAPI.dialog.openDirectory();
      if (selectedPath) {
        setLocalPath(selectedPath);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to select directory'));
    }
  };

  const handleSelectTargetDir = async () => {
    try {
      const selectedPath = await window.electronAPI.dialog.openDirectory();
      if (selectedPath) {
        setTargetDir(selectedPath);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to select directory'));
    }
  };

  const handleOpenRemoteDirectoryDialog = React.useCallback(() => {
    const nextPath = normalizeRemotePathInput(sshRepoPath) || sshBrowserPath;
    if (nextPath) {
      setSshBrowserPath(nextPath);
    }
    setRemoteDirectoryDialogOpen(true);
    setError(null);
  }, [normalizeRemotePathInput, sshBrowserPath, sshRepoPath]);

  const handleSelectRemoteDirectory = React.useCallback(() => {
    const selectedPath = normalizeRemotePathInput(sshBrowserPath);
    if (!selectedPath) {
      setError(t('Please choose a remote folder'));
      return;
    }

    setSshRepoPath(selectedPath);
    setRemoteDirectoryDialogOpen(false);
    setError(null);
  }, [normalizeRemotePathInput, sshBrowserPath, t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // When groups are hidden, always save without group
    const groupIdToSave = hideGroups ? null : selectedGroupId ? selectedGroupId : null;

    if (mode === 'local') {
      if (!localPath) {
        setError(t('Please select a local repository directory'));
        return;
      }
      if (pathValidation && !pathValidation.isDirectory) {
        setError(t('Path is not a directory'));
        return;
      }
      onAddLocal(localPath, groupIdToSave);
      handleClose();
    } else if (mode === 'ssh') {
      try {
        setIsConnectingRemote(true);
        if (activeRemoteSession) {
          if (!sshRepoPath.trim()) {
            setError(t('Please choose a remote folder'));
            return;
          }

          await onAddRemote(
            normalizeRemotePathInput(sshRepoPath),
            groupIdToSave,
            activeRemoteSession.connectionId
          );
        } else {
          if (!sshProfileId) {
            setError(t('Please choose an SSH profile first'));
            return;
          }

          const opened = await onOpenRemoteHost(sshProfileId, sshOpenTarget);
          if (!opened) {
            return;
          }
        }
        handleClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : t('Failed to connect to remote host'));
      } finally {
        setIsConnectingRemote(false);
      }
    } else {
      // Remote mode
      if (!isValidUrl) {
        setError(t('Please enter a valid Git URL'));
        return;
      }
      if (!targetDir) {
        setError(t('Please select a save location'));
        return;
      }
      if (!repoName.trim()) {
        setError(t('Please enter a repository name'));
        return;
      }

      const isWindows = window.electronAPI.env.platform === 'win32';
      const pathSep = isWindows ? '\\' : '/';
      const fullPath = `${targetDir}${pathSep}${repoName.trim()}`;

      // Create a task in the store for background tracking
      const taskId = addCloneTask({
        remoteUrl: remoteUrl.trim(),
        targetPath: fullPath,
        repoName: repoName.trim(),
        groupId: groupIdToSave,
      });
      setCloneTaskId(taskId);

      setIsCloning(true);
      setCloneProgress(null);

      try {
        const result = await window.electronAPI.git.clone(remoteUrl.trim(), fullPath);
        if (result.success) {
          completeCloneTask(taskId);
          onCloneComplete(result.path, groupIdToSave);
          handleClose();
        } else {
          failCloneTask(taskId, result.error || t('Clone failed'));
          handleCloneError(result.error || t('Clone failed'));
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : t('Clone failed');
        failCloneTask(taskId, errorMessage);
        handleCloneError(errorMessage);
      } finally {
        setIsCloning(false);
        setCloneProgress(null);
        setCloneTaskId(null);
      }
    }
  };

  const handleCloneError = (errorMessage: string) => {
    if (errorMessage.includes('already exists')) {
      setError(
        t(
          'Target directory already exists. Please choose a different location or rename the repository.'
        )
      );
    } else if (errorMessage.includes('Authentication failed')) {
      setError(t('Authentication failed. Please check your system credentials.'));
    } else if (errorMessage.includes('Permission denied')) {
      setError(t('SSH authentication failed. Please check your SSH key configuration.'));
    } else if (errorMessage.includes('not found') || errorMessage.includes('does not exist')) {
      setError(t('Remote repository not found. Please check the URL.'));
    } else if (errorMessage.includes('unable to access')) {
      setError(t('Unable to connect to remote repository. Please check your network.'));
    } else if (errorMessage.includes('Invalid Git URL')) {
      setError(t('Invalid Git URL format. Please enter a valid HTTPS or SSH URL.'));
    } else {
      setError(errorMessage);
    }
  };

  const handleClose = () => {
    if (isCloning || isConnectingRemote) return;
    resetForm();
    onOpenChange(false);
  };

  // Minimize the dialog while clone continues in background
  const handleMinimize = () => {
    // Clone will continue in background via the store
    // Reset ALL form state including isCloning since the task is now managed by the store
    resetForm();
    onOpenChange(false);
  };

  const resetForm = () => {
    setMode(defaultMode);
    groupSelectionTouchedRef.current = false;
    setSelectedGroupId(defaultGroupId || '');
    setLocalPath('');
    setPathValidation(null);
    setIsValidating(false);
    setRemoteUrl('');
    setTargetDir('');
    setRepoName('');
    setIsValidUrl(false);
    setSshProfileId('');
    setSshRepoPath('');
    setSshRoots([]);
    setSshEntries([]);
    setSshBrowserPath('');
    setIsLoadingProfiles(false);
    setIsLoadingRoots(false);
    setIsLoadingEntries(false);
    setIsConnectingRemote(false);
    setRemoteDirectoryDialogOpen(false);
    setSshOpenTarget('current-window');
    setError(null);
    setIsCloning(false);
    setCloneProgress(null);
    setCreateGroupDialogOpen(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isCloning) {
      // When closing while cloning, minimize instead of blocking
      handleMinimize();
      return;
    }
    if (!newOpen && isConnectingRemote) {
      return;
    }
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  };

  const getProgressLabel = () => {
    if (!cloneProgress) return '';
    // stageLabels 已使用 t() 翻译，直接返回即可
    return stageLabels[cloneProgress.stage] || cloneProgress.stage;
  };

  const isSubmitDisabled = () => {
    if (isCloning || isConnectingRemote) return true;
    if (mode === 'local') {
      return !localPath || isValidating || (pathValidation !== null && !pathValidation.isDirectory);
    }
    if (mode === 'ssh') {
      if (!activeRemoteSession) {
        return !sshProfileId || isLoadingProfiles;
      }
      return !sshRepoPath.trim() || isLoadingRoots || isLoadingEntries;
    }
    return !isValidUrl || !targetDir || !repoName.trim();
  };

  const sshDirectoryEntries = React.useMemo(
    () =>
      sshEntries.filter((entry) => entry.isDirectory).sort((a, b) => a.name.localeCompare(b.name)),
    [sshEntries]
  );

  const sshParentPath = React.useMemo(
    () => getRemoteParentPath(sshBrowserPath),
    [getRemoteParentPath, sshBrowserPath]
  );

  const selectedGroupLabel = React.useMemo(() => {
    if (!selectedGroupId) return t('No Group');
    const group = groups.find((g) => g.id === selectedGroupId);
    if (!group) return t('No Group');
    return (
      <span className="flex min-w-0 items-center gap-2">
        {group.emoji && <span className="shrink-0 text-base">{group.emoji}</span>}
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full border"
          style={{ backgroundColor: group.color }}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
      </span>
    );
  }, [groups, selectedGroupId, t]);

  const handleCreateGroup = React.useCallback(
    (name: string, emoji: string, color: string) => {
      const newGroup = onCreateGroup(name, emoji, color);
      groupSelectionTouchedRef.current = true;
      setSelectedGroupId(newGroup.id);
      return newGroup;
    },
    [onCreateGroup]
  );

  const dialogTitle =
    dialogVariant === 'connect-remote-host'
      ? t('Connect to Remote Host')
      : dialogVariant === 'add-remote-project'
        ? t('Add Repository')
        : t('Add Repository');

  const dialogDescription =
    dialogVariant === 'connect-remote-host'
      ? t(
          'Open a full remote host window over SSH. This window will switch completely to that host.'
        )
      : dialogVariant === 'add-remote-project'
        ? t('Choose a project directory on the current remote host.')
        : t('Add a local Git repository or clone from a remote URL.');

  const groupSelect = (
    <Field>
      <FieldLabel>{t('Group')}</FieldLabel>
      <Select
        value={selectedGroupId}
        onValueChange={(v) => {
          groupSelectionTouchedRef.current = true;
          setSelectedGroupId(v || '');
        }}
        disabled={isCloning || isConnectingRemote}
      >
        <div className="flex w-full items-center gap-2">
          <SelectTrigger className="min-w-0 flex-1 w-auto">
            <SelectValue>{selectedGroupLabel}</SelectValue>
          </SelectTrigger>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            onClick={() => setCreateGroupDialogOpen(true)}
            disabled={isCloning || isConnectingRemote}
            title={t('New Group')}
            aria-label={t('New Group')}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
          <SelectItem value="">{t('No Group')}</SelectItem>
          {groups.length > 0 && <SelectSeparator />}
          {groups.map((group) => (
            <SelectItem key={group.id} value={group.id}>
              <span className="flex min-w-0 items-center gap-2">
                {group.emoji && <span className="shrink-0 text-base">{group.emoji}</span>}
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full border"
                  style={{ backgroundColor: group.color }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <form onSubmit={handleSubmit} className="flex flex-col">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-4">
            {showTabs ? (
              <Tabs
                value={mode}
                onValueChange={(v) => {
                  if (isCloning || isConnectingRemote) return;
                  setMode(v as AddMode);
                  setError(null);
                }}
              >
                <TabsList className="w-full">
                  <TabsTrigger
                    value="local"
                    className="flex-1"
                    disabled={isCloning || isConnectingRemote}
                  >
                    <FolderOpen className="h-4 w-4 shrink-0" />
                    <span className="truncate">{t('Local')}</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="remote"
                    className="flex-1"
                    disabled={isCloning || isConnectingRemote}
                  >
                    <Globe className="h-4 w-4 shrink-0" />
                    <span className="truncate">{t('Clone')}</span>
                  </TabsTrigger>
                </TabsList>

                {/* Local Repository Tab */}
                <TabsContent value="local" className="mt-4 space-y-4">
                  <Field>
                    <FieldLabel>{t('Repository directory')}</FieldLabel>
                    <Autocomplete
                      value={localPath}
                      onValueChange={(v) => {
                        setLocalPath(v ?? '');
                        setError(null);
                      }}
                      items={recentProjects}
                      filter={filterProject}
                      itemToStringValue={(item) => item.path}
                    >
                      <div className="flex w-full gap-2">
                        <AutocompleteInput
                          placeholder={t('Type a path or select from recent projects...')}
                          className="min-w-0 flex-1"
                          showClear={!!localPath}
                          showTrigger
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleSelectLocalPath}
                          className="shrink-0"
                        >
                          {t('Browse')}
                        </Button>
                      </div>
                      <AutocompletePopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                        <AutocompleteEmpty>{t('No matching projects found')}</AutocompleteEmpty>
                        <AutocompleteList>
                          {(project: RecentEditorProject) => (
                            <AutocompleteItem key={project.path} value={project}>
                              <Tooltip>
                                <TooltipTrigger className="min-w-0 flex-1 truncate text-left text-sm">
                                  {formatPathDisplay(project.path)}
                                </TooltipTrigger>
                                <TooltipPopup side="right" sideOffset={8}>
                                  {project.path}
                                </TooltipPopup>
                              </Tooltip>
                            </AutocompleteItem>
                          )}
                        </AutocompleteList>
                      </AutocompletePopup>
                    </Autocomplete>
                    <FieldDescription>
                      {isValidating && (
                        <span className="text-muted-foreground">{t('Validating...')}</span>
                      )}
                      {!isValidating && pathValidation && !pathValidation.exists && (
                        <span className="text-destructive">{t('Path does not exist')}</span>
                      )}
                      {!isValidating &&
                        pathValidation &&
                        pathValidation.exists &&
                        !pathValidation.isDirectory && (
                          <span className="text-destructive">{t('Path is not a directory')}</span>
                        )}
                      {!isValidating && pathValidation && pathValidation.isDirectory && (
                        <span className="text-green-600">✓ {t('Valid directory')}</span>
                      )}
                      {!localPath &&
                        !isValidating &&
                        t('Select a local directory on your computer.')}
                    </FieldDescription>
                  </Field>

                  {!hideGroups && groupSelect}
                </TabsContent>

                {/* Remote Repository Tab */}
                <TabsContent value="remote" className="mt-4 space-y-4">
                  {/* Repository URL */}
                  <Field>
                    <FieldLabel>{t('Repository URL')}</FieldLabel>
                    <Input
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                      placeholder="https://github.com/user/repo.git"
                      disabled={isCloning}
                      autoFocus
                    />
                    <FieldDescription>
                      {t('Supports HTTPS and SSH protocols.')}
                      {remoteUrl && !isValidUrl && (
                        <span className="ml-2 text-destructive">{t('Invalid URL format')}</span>
                      )}
                      {remoteUrl && isValidUrl && (
                        <span className="ml-2 text-green-600">✓ {t('Valid URL')}</span>
                      )}
                    </FieldDescription>
                  </Field>

                  {/* Save Location */}
                  <Field>
                    <FieldLabel>{t('Save location')}</FieldLabel>
                    <div className="flex w-full gap-2">
                      <Input
                        value={targetDir}
                        readOnly
                        placeholder={t('Select a directory...')}
                        className="min-w-0 flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleSelectTargetDir}
                        disabled={isCloning}
                        className="shrink-0"
                      >
                        {t('Browse')}
                      </Button>
                    </div>
                  </Field>

                  {/* Repository Name */}
                  <Field>
                    <FieldLabel>{t('Repository name')}</FieldLabel>
                    <Input
                      value={repoName}
                      onChange={(e) => setRepoName(e.target.value)}
                      placeholder={t('Repository folder name')}
                      disabled={isCloning}
                    />
                    <FieldDescription>
                      {t('The folder name for the cloned repository.')}
                    </FieldDescription>
                  </Field>

                  {!hideGroups && groupSelect}

                  {/* Clone Progress */}
                  {isCloning && (
                    <div className="space-y-2">
                      <Progress value={cloneProgress?.progress || 0} className="h-2" />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span className="flex items-center gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {getProgressLabel()}
                        </span>
                        <span>{cloneProgress?.progress || 0}%</span>
                      </div>
                    </div>
                  )}

                  {/* Full Path Preview */}
                  {targetDir && repoName && !isCloning && (
                    <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                      <span className="font-medium">{t('Full path')}:</span>
                      <code className="ml-1 break-all">
                        {targetDir}
                        {window.electronAPI.env.platform === 'win32' ? '\\' : '/'}
                        {repoName}
                      </code>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            ) : (
              <div className="space-y-4">
                {activeRemoteSession ? (
                  <>
                    <Field>
                      <FieldLabel>{t('Repository directory')}</FieldLabel>
                      <div className="flex w-full gap-2">
                        <Input
                          value={sshRepoPath}
                          onChange={(event) => {
                            setSshRepoPath(event.target.value);
                            setError(null);
                          }}
                          placeholder={t('/srv/project or ~/workspace/project')}
                          disabled={isLoadingRoots || isConnectingRemote}
                          className="min-w-0 flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleOpenRemoteDirectoryDialog}
                          disabled={isLoadingRoots || isConnectingRemote}
                          className="shrink-0"
                        >
                          {t('Browse')}
                        </Button>
                      </div>
                      <FieldDescription>
                        {isLoadingRoots
                          ? t('Resolving directories on this host...')
                          : t('Choose a project directory on the current remote host.')}
                      </FieldDescription>
                    </Field>

                    {!hideGroups && groupSelect}
                  </>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-2">
                    <Field className="min-w-0">
                      <FieldLabel>{t('SSH profile')}</FieldLabel>
                      <Select
                        value={sshProfileId}
                        onValueChange={(value) => {
                          setSshProfileId(value ?? '');
                          setError(null);
                        }}
                      >
                        <SelectTrigger className="min-w-0" disabled={isConnectingRemote}>
                          <SelectValue>
                            {sshProfileId
                              ? remoteProfiles.find((profile) => profile.id === sshProfileId)
                                  ?.name || t('Unknown profile')
                              : isLoadingProfiles
                                ? t('Loading profiles...')
                                : t('Select a saved SSH profile')}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                          {remoteProfiles.length === 0 ? (
                            <SelectItem value="" disabled>
                              {t('No saved profiles')}
                            </SelectItem>
                          ) : (
                            remoteProfiles.map((profile) => (
                              <SelectItem key={profile.id} value={profile.id}>
                                {profile.name}
                              </SelectItem>
                            ))
                          )}
                        </SelectPopup>
                      </Select>
                      <FieldDescription>
                        {remoteProfiles.length === 0
                          ? t(
                              'Create SSH profiles in Settings > Remote Connection first, then use the Remote Host entry to connect.'
                            )
                          : t(
                              'Connecting will open a full remote host window, not a single folder.'
                            )}
                      </FieldDescription>
                    </Field>

                    <Field className="min-w-0">
                      <FieldLabel>{t('Open in')}</FieldLabel>
                      <Select
                        value={sshOpenTarget}
                        onValueChange={(value) => {
                          setSshOpenTarget((value as RemoteWindowOpenTarget) || 'current-window');
                        }}
                      >
                        <SelectTrigger className="min-w-0" disabled={isConnectingRemote}>
                          <SelectValue>
                            {sshOpenTarget === 'current-window'
                              ? t('Current Window')
                              : t('New Window')}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                          <SelectItem value="current-window">{t('Current Window')}</SelectItem>
                          <SelectItem value="new-window">{t('New Window')}</SelectItem>
                        </SelectPopup>
                      </Select>
                      <FieldDescription>
                        {t('After connecting, the whole window switches to that remote host.')}
                      </FieldDescription>
                    </Field>
                  </div>
                )}
              </div>
            )}

            {/* Error Display */}
            {error && (
              <div className="rounded-lg border border-destructive/24 bg-destructive/6 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
          </DialogPanel>

          <DialogFooter variant="bare">
            {isCloning ? (
              <Button
                type="button"
                variant="outline"
                className="min-w-24 justify-center"
                onClick={handleMinimize}
              >
                <Minus className="mr-2 h-4 w-4" />
                {t('Minimize')}
              </Button>
            ) : isConnectingRemote ? (
              <Button type="button" variant="outline" className="min-w-24 justify-center" disabled>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('Connecting...')}
              </Button>
            ) : (
              <DialogClose
                render={
                  <Button variant="outline" className="min-w-24 justify-center">
                    {t('Cancel')}
                  </Button>
                }
              />
            )}
            <Button type="submit" className="min-w-24 justify-center" disabled={isSubmitDisabled()}>
              {isCloning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('Cloning...')}
                </>
              ) : isConnectingRemote ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('Connecting...')}
                </>
              ) : mode === 'local' ? (
                t('Add')
              ) : mode === 'ssh' ? (
                activeRemoteSession ? (
                  t('Add Repository')
                ) : (
                  t('Connect')
                )
              ) : (
                t('Clone')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>

      <Dialog
        open={Boolean(activeRemoteSession) && remoteDirectoryDialogOpen}
        onOpenChange={setRemoteDirectoryDialogOpen}
      >
        <DialogPopup className="max-w-2xl" zIndexLevel="nested">
          <DialogHeader>
            <DialogTitle>{t('Repository directory')}</DialogTitle>
            <DialogDescription>
              {t('Choose a project directory on the current remote host.')}
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-4">
            {sshRoots.length > 0 && (
              <div className="flex flex-wrap gap-2 rounded-xl border bg-muted/20 p-3">
                {sshRoots.map((root) => (
                  <Button
                    key={root}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isLoadingRoots || isConnectingRemote}
                    onClick={() => {
                      setSshBrowserPath(normalizeRemotePathInput(root));
                      setError(null);
                    }}
                  >
                    {root}
                  </Button>
                ))}
              </div>
            )}

            <div className="space-y-3 rounded-xl border bg-muted/10 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('Current location')}
                  </p>
                  <p className="truncate font-mono text-xs text-foreground">
                    {sshBrowserPath || t('No folder selected')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={!sshParentPath || isLoadingEntries || isConnectingRemote}
                    onClick={() => {
                      if (!sshParentPath) return;
                      setSshBrowserPath(sshParentPath);
                    }}
                    title={t('Go to parent folder')}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={!sshProfileId || !sshBrowserPath || isConnectingRemote}
                    onClick={() => {
                      if (!sshProfileId || !sshBrowserPath) return;
                      void loadSshDirectory(sshProfileId, sshBrowserPath);
                    }}
                    title={t('Refresh')}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="max-h-72 overflow-y-auto rounded-lg border bg-background/80">
                {isLoadingEntries ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('Loading folders...')}
                  </div>
                ) : sshDirectoryEntries.length > 0 ? (
                  sshDirectoryEntries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent/50"
                      disabled={isConnectingRemote}
                      onClick={() => {
                        setSshBrowserPath(entry.path);
                        setError(null);
                      }}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-yellow-500" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {sshBrowserPath
                      ? t('This folder has no subfolders')
                      : t('Choose a root folder to start browsing')}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              {t(
                'The selected directory will be added as a project from this remote host in the current window.'
              )}
            </div>

            {error && (
              <div className="rounded-lg border border-destructive/24 bg-destructive/6 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
          </DialogPanel>

          <DialogFooter variant="bare">
            <Button variant="outline" onClick={() => setRemoteDirectoryDialogOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button
              onClick={handleSelectRemoteDirectory}
              disabled={!sshBrowserPath || isLoadingRoots || isLoadingEntries || isConnectingRemote}
            >
              {t('Select')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <CreateGroupDialog
        open={createGroupDialogOpen}
        onOpenChange={setCreateGroupDialogOpen}
        onSubmit={handleCreateGroup}
      />
    </Dialog>
  );
}
