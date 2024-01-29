import {
  ContentLayout,
  Header,
  SpaceBetween,
  AppLayout,
  Tabs,
} from '@cloudscape-design/components';
import React from 'react';
import Messages from './Messages';
import Status from './Status';
import Transcription from './Transcription';
import '@cloudscape-design/global-styles/index.css';

import { useWebSocket } from './WebSocketContext';

const App: React.FC = () => {
  const { messages, transcriptions, currentLine } = useWebSocket();

  return (
    <AppLayout
      content={
        <ContentLayout
          header={
            <Header variant='h1'>
              Amazon Chime SDK Call Analytics Producer
            </Header>
          }
        >
          <SpaceBetween size='xl'>
            <Status />
            <Tabs
              tabs={[
                {
                  label: 'Messages',
                  id: 'Messages',
                  content: <Messages />,
                  disabled: messages.length === 0,
                },
                {
                  label: 'Transcriptions',
                  id: 'Transcriptions',
                  content: <Transcription />,
                  disabled:
                    transcriptions.length === 0 && currentLine.length === 0,
                },
              ]}
              variant='container'
            />
          </SpaceBetween>
        </ContentLayout>
      }
      navigationHide={true}
      toolsHide={true}
    />
  );
};

export default App;
