import { TextEncoder } from 'util';
import {
  ApiGatewayManagementApi,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { KinesisStreamRecord, APIGatewayProxyEvent } from 'aws-lambda';

const TRANSCRIBE_TABLE = process.env.TRANSCRIBE_TABLE;
const CONNECTION_TABLE = process.env.CONNECTION_TABLE;
const API_GATEWAY_ENDPOINT = process.env.API_GATEWAY_ENDPOINT;

const apiGatewayManagementApi = new ApiGatewayManagementApi({
  apiVersion: '2018-11-29',
  endpoint: API_GATEWAY_ENDPOINT,
});

interface AttributeValue {
  S?: string;
  N?: string;
}

interface Connection extends Record<string, AttributeValue> {
  connectionId: {
    S: string;
  };
}

const dynamoDBClient = new DynamoDBClient({});

interface Metadata {
  callId: string;
  fromNumber: string;
  voiceConnectorId: string;
  toNumber: string;
  transactionId: string;
  direction: string;
}

interface KinesisRecord {
  'time': string;
  'service-type': string;
  'detail-type': string;
  'mediaInsightsPipelineId': string;
  'TranscriptEvent': {
    ResultId: string;
    StartTime: number;
    EndTime: number;
    IsPartial: boolean;
    Alternatives: {
      Transcript: string;
      Items: Array<{
        StartTime: number;
        EndTime: number;
        ItemType: string;
        Content: string;
        VocabularyFilterMatch: boolean;
        Speaker: null | string;
        Confidence: null | number;
        Stable: null | boolean;
      }>;
      Entities: null;
    }[];
    ChannelId: string;
  };
  'metadata': string;
}

async function handleApiGatewayEvent(event: APIGatewayProxyEvent) {
  console.log('API Gateway Request');
  if (event.requestContext.connectionId === undefined) {
    console.error('connectionId is undefined');
    return { statusCode: 500 };
  }
  const connectionId: string = event.requestContext.connectionId;

  if (event.requestContext.eventType === 'CONNECT') {
    await putConnectionInDynamoDB(connectionId);
    return { statusCode: 200 };
  } else if (event.requestContext.eventType === 'DISCONNECT') {
    await deleteConnectionFromDynamoDB(connectionId);
    return { statusCode: 200 };
  } else {
    return { statusCode: 400 };
  }
}

async function handleKinesisRecords(records: KinesisStreamRecord[]) {
  console.log('KDS Records Request');
  for (const record of records) {
    const kinesisData = Buffer.from(record.kinesis.data, 'base64').toString(
      'utf8',
    );
    console.debug('Decoded payload:', kinesisData);
    const postData: KinesisRecord = JSON.parse(kinesisData);
    console.debug('Post Data:', postData);

    if (
      postData['detail-type'] === 'Transcribe' &&
      !postData.TranscriptEvent.IsPartial
    ) {
      await insertRecordIntoDynamoDB(postData);
    }
    await sendToConnectedClients(postData);
  }
}

async function putConnectionInDynamoDB(connectionId: string) {
  const putParams = {
    TableName: CONNECTION_TABLE,
    Item: { connectionId: { S: connectionId } },
  };

  await dynamoDBClient.send(new PutItemCommand(putParams));
}

async function deleteConnectionFromDynamoDB(connectionId: string) {
  const deleteParams = {
    TableName: CONNECTION_TABLE,
    Key: { connectionId: { S: connectionId } },
  };

  await dynamoDBClient.send(new DeleteItemCommand(deleteParams));
}

async function insertRecordIntoDynamoDB(postData: KinesisRecord) {
  const metadata: Metadata = JSON.parse(postData.metadata);
  console.info('Inserting record into DynamoDB');
  console.info(
    'Transcript:',
    postData.TranscriptEvent.Alternatives[0].Transcript,
  );

  const date = new Date(postData.time);
  const epochTime = date.getTime().toString();
  try {
    const putCommand = new PutItemCommand({
      TableName: TRANSCRIBE_TABLE,
      Item: {
        transactionId: { S: metadata.transactionId },
        timestamp: { N: epochTime },
        channelId: { S: postData.TranscriptEvent.ChannelId },
        startTime: { N: postData.TranscriptEvent.StartTime.toString() },
        endTime: { N: postData.TranscriptEvent.EndTime.toString() },
        transcript: {
          S: postData.TranscriptEvent.Alternatives[0].Transcript,
        },
      },
    });
    await dynamoDBClient.send(putCommand);
  } catch (error) {
    console.error('Failed to insert record into DynamoDB:', error);
  }
}

async function sendToConnectedClients(postData: KinesisRecord) {
  const scanResult = await dynamoDBClient.send(
    new ScanCommand({
      TableName: CONNECTION_TABLE as string,
    }),
  );
  if (scanResult.Items) {
    const connections: Connection[] = scanResult.Items as Connection[];

    console.log('Connections: ' + JSON.stringify(connections));
    for (const connection of connections) {
      try {
        console.log(`Connection: ${connection.connectionId.S}`);
        console.log(`Post Data: ${JSON.stringify(postData)}`);
        await apiGatewayManagementApi.send(
          new PostToConnectionCommand({
            ConnectionId: connection.connectionId.S,
            Data: new TextEncoder().encode(JSON.stringify(postData)),
          }),
        );
      } catch (error) {
        if (error && typeof error === 'object' && 'statusCode' in error) {
          if (error.statusCode === 410) {
            // Remove stale connections
            await dynamoDBClient.send(
              new DeleteItemCommand({
                TableName: CONNECTION_TABLE as string,
                Key: { connectionId: { S: connection.connectionId.S } },
              }),
            );
          }
        } else {
          console.error('An error occurred: ', error);
        }
      }
    }
  }
}

exports.handler = async (
  event: APIGatewayProxyEvent | { Records: KinesisStreamRecord[] },
) => {
  console.log(`Event: ${JSON.stringify(event, null, 2)}`);

  if ('requestContext' in event) {
    // API Gateway Event
    return handleApiGatewayEvent(event as APIGatewayProxyEvent);
  } else {
    // Kinesis Stream Records
    return handleKinesisRecords(event.Records);
  }
};
