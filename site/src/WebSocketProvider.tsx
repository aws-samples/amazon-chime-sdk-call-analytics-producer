import React, { useState, useEffect } from 'react';
import config from './Config';
import { Message } from './Types';
import { WebSocketContext } from './WebSocketContext';

const WEBSOCKET_URL = config.WEBSOCKET_URL;

interface WebSocketProviderProps {
  children: React.ReactNode;
}

export const WebSocketProvider: React.FC<WebSocketProviderProps> = ({
  children,
}) => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [connected, setConnected] = useState(false);
  const [transcriptions, setTranscriptions] = useState<Message[]>([]);
  const [sentiments, setSentiments] = useState<Message[]>([]);
  const [currentLine, setCurrentLine] = useState<Message[]>([]);
  const [summarization, setSummarization] = useState('');
  const [recordingUrl, setRecordingUrl] = useState('');

  useEffect(() => {
    setupWebSocket();
  }, []);

  const setupWebSocket = () => {
    const ws = new WebSocket(WEBSOCKET_URL);

    ws.onopen = () => {
      console.debug('Connected to WebSocket');
      setSocket(ws);
      setConnected(true);
    };

    ws.onmessage = (event) => {
      console.debug('Received message:', event.data);
      const data: Message = JSON.parse(event.data);
      setMessages((prevMessages) => [...prevMessages, data]);

      if (data['detail-type'] === 'Transcribe') {
        handleTranscribeData(data);
      } else if (data['detail-type'] === 'VoiceToneAnalysisStatus') {
        handleVoiceToneAnalysisStatus(data);
      } else if (data['detail-type'] === 'Recording') {
        handleRecordingData(data);
      } else if (data['detail-type'] === 'Summarization') {
        handleSummarizationData(data);
      }
    };

    ws.onerror = (error: Event) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.debug('WebSocket connection closed');
      setSocket(null);
      setConnected(false);
    };

    return () => {
      ws.close();
    };
  };

  const handleTranscribeData = (data: Message) => {
    if (data.TranscriptEvent && data.TranscriptEvent.Alternatives) {
      if (data.TranscriptEvent.IsPartial) {
        console.debug('Partial transcription:', data);
        setCurrentLine([data]);
      } else {
        console.debug('Full transcription:', data);
        setTranscriptions((prevTranscriptions) => [
          ...prevTranscriptions,
          data,
        ]);
        setCurrentLine([]);
      }
    }
  };

  const handleVoiceToneAnalysisStatus = (data: Message) => {
    if (data.detail.detailStatus === 'VoiceToneAnalysisSuccessful') {
      console.log('Voice Sentiment: ', data);
      setSentiments((prevSentiments) => [...prevSentiments, data]);
    }
  };

  const handleRecordingData = (data: Message) => {
    if (data.s3MediaObjectConsoleUrl) {
      setRecordingUrl(data.s3MediaObjectConsoleUrl);
    }
  };

  const handleSummarizationData = (data: Message) => {
    console.debug('Received summarization:', data.summarization);
    setSummarization(data.summarization);
  };

  const clearMessages = () => {
    setMessages([]);
    setTranscriptions([]);
    setCurrentLine([]);
    setSentiments([]);
    setSummarization('');
    setRecordingUrl('');
  };

  const connectToWs = () => {
    setupWebSocket();
  };

  const value = {
    connected,
    connectToWs,
    socket,
    messages,
    transcriptions,
    sentiments,
    currentLine,
    summarization,
    clearMessages,
    recordingUrl,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketProvider;
