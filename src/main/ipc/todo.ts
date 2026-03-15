import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { remoteSessionManager } from '../services/remote/RemoteSessionManager';
import * as todoService from '../services/todo/TodoService';

let readyPromise: Promise<void>;

/** Ensure DB is ready before processing any IPC call */
async function ensureReady(): Promise<void> {
  await readyPromise;
}

export function registerTodoHandlers(): void {
  readyPromise = todoService.initialize().catch((err) => {
    console.error('[Todo IPC] Failed to initialize TodoService:', err);
  });

  ipcMain.handle(IPC_CHANNELS.TODO_GET_TASKS, async (event, repoPath: string) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return remoteSessionManager.getTodoTasks(event.sender, repoPath);
    }
    await ensureReady();
    return todoService.getTasks(repoPath);
  });

  ipcMain.handle(
    IPC_CHANNELS.TODO_ADD_TASK,
    async (
      event,
      repoPath: string,
      task: {
        id: string;
        title: string;
        description: string;
        priority: string;
        status: string;
        order: number;
        createdAt: number;
        updatedAt: number;
      }
    ) => {
      if (remoteSessionManager.hasSession(event.sender)) {
        return remoteSessionManager.addTodoTask(event.sender, repoPath, task);
      }
      await ensureReady();
      return todoService.addTask(repoPath, task);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TODO_UPDATE_TASK,
    async (
      event,
      repoPath: string,
      taskId: string,
      updates: { title?: string; description?: string; priority?: string; status?: string }
    ) => {
      if (remoteSessionManager.hasSession(event.sender)) {
        return remoteSessionManager.updateTodoTask(event.sender, repoPath, taskId, updates);
      }
      await ensureReady();
      return todoService.updateTask(repoPath, taskId, updates);
    }
  );

  ipcMain.handle(IPC_CHANNELS.TODO_DELETE_TASK, async (event, repoPath: string, taskId: string) => {
    if (remoteSessionManager.hasSession(event.sender)) {
      return remoteSessionManager.deleteTodoTask(event.sender, repoPath, taskId);
    }
    await ensureReady();
    return todoService.deleteTask(repoPath, taskId);
  });

  ipcMain.handle(
    IPC_CHANNELS.TODO_MOVE_TASK,
    async (event, repoPath: string, taskId: string, newStatus: string, newOrder: number) => {
      if (remoteSessionManager.hasSession(event.sender)) {
        return remoteSessionManager.moveTodoTask(
          event.sender,
          repoPath,
          taskId,
          newStatus,
          newOrder
        );
      }
      await ensureReady();
      return todoService.moveTask(repoPath, taskId, newStatus, newOrder);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TODO_REORDER_TASKS,
    async (event, repoPath: string, status: string, orderedIds: string[]) => {
      if (remoteSessionManager.hasSession(event.sender)) {
        return remoteSessionManager.reorderTodoTasks(event.sender, repoPath, status, orderedIds);
      }
      await ensureReady();
      return todoService.reorderTasks(repoPath, status, orderedIds);
    }
  );

  ipcMain.handle(IPC_CHANNELS.TODO_MIGRATE, async (_, boardsJson: string) => {
    await ensureReady();
    return todoService.migrateFromLocalStorage(boardsJson);
  });
}

export function cleanupTodo(): Promise<void> {
  return todoService.close();
}

export function cleanupTodoSync(): void {
  todoService.closeSync();
}
