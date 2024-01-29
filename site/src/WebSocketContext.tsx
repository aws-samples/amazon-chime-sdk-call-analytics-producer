import { createContext, useContext } from 'react';
import { Message } from './Types';

interface WebSocketContextValue {
  connected: boolean;
  socket: WebSocket | null;
  messages: Message[];
  transcriptions: Message[];
  currentLine: Message[];
  summarization: string;
  recordingUrl: string;
  sentiments: Message[];
  clearMessages: () => void;
  connectToWs: () => void;
}

export const WebSocketContext = createContext<WebSocketContextValue | null>(
  null,
);

export const useWebSocket = (): WebSocketContextValue => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};
