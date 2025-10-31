"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@background-agent/shared";

interface TasksSnapshot {
  tasks: Task[];
}

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
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setTasks(normalizeList(initialTasks));
  }, [initialTasks]);

  useEffect(() => {
    const source = new EventSource("/events/tasks");
    eventSourceRef.current = source;

    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot: TasksSnapshot = JSON.parse(event.data);
        setTasks(normalizeList(snapshot.tasks));
      } catch (error) {
        console.error("Failed to parse task snapshot", error);
      }
    };

    const handleTaskUpdate = (event: MessageEvent<string>) => {
      try {
        const task: Task = JSON.parse(event.data);
        setTasks((prev) => applyUpsert(prev, task));
      } catch (error) {
        console.error("Failed to parse task update", error);
      }
    };

    const handleTaskDeleted = (event: MessageEvent<string>) => {
      try {
        const payload: { id: string } = JSON.parse(event.data);
        setTasks((prev) => prev.filter((task) => task.id !== payload.id));
      } catch (error) {
        console.error("Failed to parse task deletion", error);
      }
    };

    source.addEventListener("snapshot", handleSnapshot as EventListener);
    source.addEventListener("task", handleTaskUpdate as EventListener);
    source.addEventListener("task.deleted", handleTaskDeleted as EventListener);

    source.onopen = () => setIsConnected(true);
    source.onerror = () => setIsConnected(false);

    return () => {
      source.removeEventListener("snapshot", handleSnapshot as EventListener);
      source.removeEventListener("task", handleTaskUpdate as EventListener);
      source.removeEventListener("task.deleted", handleTaskDeleted as EventListener);
      source.close();
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
