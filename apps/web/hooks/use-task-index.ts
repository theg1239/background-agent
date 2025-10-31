"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Task } from "@background-agent/shared";
import { getSocket } from "../lib/client/socket";

function normalizeList(list: Task[]): Task[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

function applyUpsert(list: Task[], next: Task) {
  const index = list.findIndex((task) => task.id === next.id);
  if (index === -1) {
    return normalizeList([next, ...list]);
  }
  const copy = [...list];
  copy.splice(index, 1, next);
  return normalizeList(copy);
}

export function useTaskIndex(initialTasks: Task[]) {
  const [tasks, setTasks] = useState<Task[]>(() => normalizeList(initialTasks));
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    setTasks(normalizeList(initialTasks));
  }, [initialTasks]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    socketRef.current = socket;

    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);
    const handleTaskUpdate = (task: Task) => {
      setTasks((prev) => applyUpsert(prev, task));
    };
    const handleTaskDeleted = (payload: { id: string }) => {
      if (!payload?.id) return;
      setTasks((prev) => prev.filter((task) => task.id !== payload.id));
    };

    if (socket.connected) {
      setIsConnected(true);
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("task:update", handleTaskUpdate);
    socket.on("task:deleted", handleTaskDeleted);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("task:update", handleTaskUpdate);
      socket.off("task:deleted", handleTaskDeleted);
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, []);

  const upsertTask = useCallback((task: Task) => {
    setTasks((prev) => applyUpsert(prev, task));
  }, []);

  const replaceTask = useCallback((existingId: string, next: Task) => {
    setTasks((prev) => {
      const copy = [...prev];
      const index = copy.findIndex((task) => task.id === existingId);
      if (index === -1) {
        return applyUpsert(copy, next);
      }
      copy.splice(index, 1, next);
      return normalizeList(copy);
    });
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((task) => task.id !== id));
  }, []);

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  return {
    tasks,
    taskById,
    isConnected,
    upsertTask,
    replaceTask,
    removeTask
  };
}
