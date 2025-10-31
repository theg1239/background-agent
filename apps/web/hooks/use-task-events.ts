"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { getSocket } from "../lib/client/socket";
import {
  Task,
  TaskEvent,
  TaskEventStreamSnapshot,
  TaskPlanStepSchema,
  TaskStatusSchema
} from "@background-agent/shared";

interface Options {
  initialSnapshot?: TaskEventStreamSnapshot;
}

export function useTaskEvents(taskId?: string, options?: Options) {
  const [events, setEvents] = useState<TaskEvent[]>(() => options?.initialSnapshot?.events ?? []);
  const [task, setTask] = useState<Task | undefined>(options?.initialSnapshot?.task);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const lastSubscribedTaskId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (options?.initialSnapshot) {
      setTask(options.initialSnapshot.task);
      setEvents(options.initialSnapshot.events);
    }
  }, [options?.initialSnapshot?.task?.id]);

  useEffect(() => {
    const socket = getSocket();
    if (lastSubscribedTaskId.current && socket) {
      socket.emit("task:unsubscribe", lastSubscribedTaskId.current);
      lastSubscribedTaskId.current = undefined;
    }

    if (!taskId || taskId.startsWith("temp-")) {
      setIsConnected(false);
      if (!taskId) {
        setEvents([]);
        setTask(undefined);
      }
      return;
    }

    const abortController = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/tasks/${taskId}/events`, {
          cache: "no-store",
          signal: abortController.signal
        });
        if (!response.ok) {
          throw new Error(`Failed to load task snapshot (${response.status})`);
        }
        const snapshot = (await response.json()) as TaskEventStreamSnapshot;
        if (!cancelled) {
          setTask(snapshot.task);
          setEvents(snapshot.events);
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("Failed to load task snapshot", error);
        }
      }
    })().catch((error) => {
      console.error("Unexpected snapshot error", error);
    });

    if (!socket) {
      return () => {
        cancelled = true;
        abortController.abort();
        setIsConnected(false);
      };
    }

    socketRef.current = socket;

    const handleConnect = () => setIsConnected(true);
    const handleDisconnect = () => setIsConnected(false);
    const handleTaskUpdate = (updated: Task) => {
      if (updated.id === taskId) {
        setTask(updated);
      }
    };
    const handleTaskEvent = (payload: { taskId: string; event: TaskEvent }) => {
      if (!payload || payload.taskId !== taskId) {
        return;
      }

      const parsed = payload.event;
      setEvents((prev) => {
        if (prev.some((event) => event.id === parsed.id)) {
          return prev;
        }
        return [...prev, parsed].sort((a, b) => a.timestamp - b.timestamp);
      });

      const statusResult = TaskStatusSchema.safeParse(parsed.payload?.status);
      if (statusResult.success) {
        const nextStatus = statusResult.data;
        setTask((prev) => (prev ? { ...prev, status: nextStatus } : prev));
      }

      const planResult = TaskPlanStepSchema.array().safeParse(parsed.payload?.plan);
      if (planResult.success) {
        const nextPlan = planResult.data;
        setTask((prev) => (prev ? { ...prev, plan: nextPlan } : prev));
      }
    };

    if (socket.connected) {
      setIsConnected(true);
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("task:update", handleTaskUpdate);
    socket.on("task:event", handleTaskEvent);

    socket.emit("task:subscribe", taskId);
    lastSubscribedTaskId.current = taskId;

    return () => {
      cancelled = true;
      abortController.abort();
      socket.emit("task:unsubscribe", taskId);
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("task:update", handleTaskUpdate);
      socket.off("task:event", handleTaskEvent);
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      setIsConnected(false);
    };
  }, [taskId]);

  const orderedEvents = useMemo(
    () => [...events].sort((a, b) => a.timestamp - b.timestamp),
    [events]
  );

  return {
    task,
    events: orderedEvents,
    isConnected
  };
}
