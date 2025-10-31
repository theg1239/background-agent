"use client";

import useSWR from "swr";
import { useState } from "react";
import { Task, TaskEventStreamSnapshot } from "@background-agent/shared";
import { jsonFetcher } from "@/lib/utils/fetcher";
import { useTaskEvents } from "@/hooks/use-task-events";
import { TaskList } from "./task-list";
import { TaskDetail } from "./task-detail";
import { CreateTaskForm } from "./create-task-form";

interface TasksResponse {
  tasks: Task[];
}

export function TaskDashboard({ initialTasks }: { initialTasks: Task[] }) {
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(
    initialTasks[0]?.id
  );
  const { data, mutate } = useSWR<TasksResponse>("/api/tasks", jsonFetcher, {
    fallbackData: { tasks: initialTasks },
    refreshInterval: 30_000
  });

  const tasks = data?.tasks ?? initialTasks;
  const activeTask = tasks.find((task) => task.id === activeTaskId);

  const { data: snapshot } = useSWR<TaskEventStreamSnapshot>(
    activeTaskId ? `/api/tasks/${activeTaskId}` : null,
    jsonFetcher
  );

  const { task, events, isConnected } = useTaskEvents(activeTaskId, {
    initialSnapshot: snapshot
  });

  return (
    <div className="grid h-full gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
      <div className="space-y-6">
        <CreateTaskForm
          onCreated={async (task) => {
            await mutate();
            setActiveTaskId(task.id);
          }}
        />
        <TaskList tasks={tasks} activeTaskId={activeTaskId} onSelectTask={setActiveTaskId} />
      </div>
      <TaskDetail task={task ?? activeTask} events={events} isConnected={isConnected} />
    </div>
  );
}
