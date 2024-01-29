import {
  Box,
  ColumnLayout,
  Container,
  Header,
  StatusIndicator,
  SpaceBetween,
  Button,
} from '@cloudscape-design/components';
import React from 'react';
import { useWebSocket } from './WebSocketContext';

const Status: React.FC = () => {
  const { connected, clearMessages, connectToWs } = useWebSocket();

  return (
    <div>
      <Container
        header={
          <Header
            variant='h3'
            actions={
              <SpaceBetween direction='horizontal' size='xs'>
                {!connected && (
                  <Button variant='primary' onClick={connectToWs}>
                    Connect
                  </Button>
                )}
                <Button variant='primary' onClick={clearMessages}>
                  Clear
                </Button>
              </SpaceBetween>
            }
          >
            Status
          </Header>
        }
      >
        <ColumnLayout columns={2} variant='text-grid'>
          <Box variant='awsui-key-label'>Websocket Status</Box>
          <StatusIndicator type={connected ? 'success' : 'error'}>
            {connected ? 'Connected' : 'Disconnected'}
          </StatusIndicator>
        </ColumnLayout>
      </Container>
    </div>
  );
};

export default Status;
