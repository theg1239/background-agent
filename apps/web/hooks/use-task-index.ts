"use client";

import { useEffect, useMemo, useState } from "react";
import type { Task } from "@background-agent/shared";

interface TasksSnapshot {
  tasks: Task[];
}

function upsertTask(list: Task[], next: Task) {
  const index = list.findIndex((task) => task.id === next.id);
  if (index === -1) {
    return [next, ...list].sort((a, b) => b.createdAt - a.createdAt);
  }
  const copy = [...list];
  copy.splice(index, 1, next);
  return copy.sort((a, b) => b.createdAt - a.createdAt);
}

export function useTaskIndex(initialTasks: Task[]) {
  const [tasks, setTasks] = useState<Task[]>(() => [...initialTasks]);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);

  useEffect(() => {
    const source = new EventSource("/events/tasks");

    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot: TasksSnapshot = JSON.parse(event.data);
        setTasks(snapshot.tasks.sort((a, b) => b.createdAt - a.createdAt));
      } catch (error) {
        console.error("Failed to parse task snapshot", error);
      }
    };

    const handleTaskUpdate = (event: MessageEvent<string>) => {
      try {
        const task: Task = JSON.parse(event.data);
        setTasks((prev) => upsertTask(prev, task));
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

  const helpers = useMemo(
    () => ({
      upsert(task: Task) {
        setTasks((prev) => upsertTask(prev, task));
      }
    }),
    []
  );

  return {
    tasks,
    isConnected,
    upsertTask: helpers.upsert
  };
}
