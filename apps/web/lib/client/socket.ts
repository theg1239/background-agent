import type { Socket } from "socket.io-client";
import { io } from "socket.io-client";

let socketRef: Socket | null = null;

export function getSocket(): Socket | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (socketRef && socketRef.connected) {
    return socketRef;
  }

  if (!socketRef) {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";
    socketRef = io(url, {
      transports: ["websocket"],
      withCredentials: false,
      autoConnect: true
    });
  } else if (!socketRef.connected) {
    socketRef.connect();
  }

  return socketRef;
}

export function closeSocket() {
  if (socketRef) {
    socketRef.disconnect();
    socketRef = null;
  }
}
