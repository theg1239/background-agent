"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Task,
  TaskEvent,
  TaskEventStreamSnapshot,
  TASK_EVENT_TYPES
} from "@background-agent/shared";

interface Options {
  initialSnapshot?: TaskEventStreamSnapshot;
}

export function useTaskEvents(taskId?: string, options?: Options) {
  const [events, setEvents] = useState<TaskEvent[]>(() => options?.initialSnapshot?.events ?? []);
  const [task, setTask] = useState<Task | undefined>(options?.initialSnapshot?.task);
  const [isConnected, setIsConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (options?.initialSnapshot) {
      setTask(options.initialSnapshot.task);
      setEvents(options.initialSnapshot.events);
    }
  }, [options?.initialSnapshot?.task?.id]);

  useEffect(() => {
    if (!taskId || taskId.startsWith("temp-")) {
      eventSourceRef.current?.close();
      setIsConnected(false);
      if (!taskId) {
        setEvents([]);
        setTask(undefined);
      }
      return;
    }

    const source = new EventSource(`/events/tasks/${taskId}`);
    eventSourceRef.current = source;

    const handleSnapshot = (event: MessageEvent<string>) => {
      const snapshot: TaskEventStreamSnapshot = JSON.parse(event.data);
      setTask(snapshot.task);
      setEvents(snapshot.events);
    };

    source.addEventListener("snapshot", handleSnapshot as EventListener);

    const makeHandler = (_type: string) => (event: MessageEvent<string>) => {
      const parsed: TaskEvent = JSON.parse(event.data);
      setEvents((prev) => {
        if (prev.some((e) => e.id === parsed.id)) {
          return prev;
        }
        return [...prev, parsed].sort((a, b) => a.timestamp - b.timestamp);
      });
      const statusUpdate = parsed.payload?.status;
      if (typeof statusUpdate === "string") {
        setTask((prev) => (prev ? { ...prev, status: statusUpdate } : prev));
      }

      const planUpdate = parsed.payload?.plan;
      if (Array.isArray(planUpdate)) {
        setTask((prev) => (prev ? { ...prev, plan: planUpdate } : prev));
      }
    };

    const handlers = new Map<string, (event: MessageEvent<string>) => void>();
    for (const type of TASK_EVENT_TYPES) {
      const handler = makeHandler(type);
      handlers.set(type, handler);
      source.addEventListener(type, handler as EventListener);
    }

    source.onopen = () => setIsConnected(true);
    source.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      source.close();
      source.removeEventListener("snapshot", handleSnapshot as EventListener);
      for (const [type, handler] of handlers) {
        source.removeEventListener(type, handler as EventListener);
      }
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
