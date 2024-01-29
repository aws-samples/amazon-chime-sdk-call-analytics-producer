import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { Agent } from 'node:https';
import { PassThrough } from 'stream';
import {
  CreateMediaInsightsPipelineCommand,
  ChimeSDKMediaPipelinesClient,
} from '@aws-sdk/client-chime-sdk-media-pipelines';
import {
  KinesisVideoClient,
  CreateStreamCommand,
  DeleteStreamCommand,
  GetDataEndpointCommand,
  APIName,
  CreateStreamCommandOutput,
  GetDataEndpointCommandOutput,
} from '@aws-sdk/client-kinesis-video';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  STSClient,
  AssumeRoleCommand,
  AssumeRoleCommandOutput,
} from '@aws-sdk/client-sts';
import aws4 from 'aws4';
import axios, { AxiosHeaders, AxiosResponse, ResponseType } from 'axios';
import Fastify from 'fastify';
import ffmpeg from 'fluent-ffmpeg';
const fastify = Fastify({
  logger: false,
});

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const ECS_ROLE = process.env.ECS_ROLE || '';
const MEDIA_INSIGHT_CONFIGURATION_ARN =
  process.env.MEDIA_INSIGHT_CONFIGURATION_ARN || '';
const oneMB = 1024 * 1024;
const COUNT_FREQUENCY = Number(process.env.COUNT_FREQUENCY);

const stsClient = new STSClient({ region: AWS_REGION });
const kvsClient = new KinesisVideoClient({ region: AWS_REGION });
const s3Client = new S3Client({ region: AWS_REGION });
const chimeSdkMediaPipelineClient = new ChimeSDKMediaPipelinesClient({
  region: AWS_REGION,
});

interface Event {
  bucketName: string;
  keyName: string;
}

fastify.post('/processObject', async (request, reply) => {
  try {
    const event = request.body as Event;
    console.log('EVENT:', JSON.stringify(event));

    const bucketName = event.bucketName;
    const keyName = event.keyName;

    console.log('Bucket:', bucketName);
    console.log('Key:', keyName);

    await sendStream(bucketName, keyName);
  } catch (error) {
    console.error('Error:', error);
    await reply.status(500).send({ error: 'Internal Server Error' });
  }
});

fastify.get('/', async (_request, reply) => {
  await reply.status(200).send('OK');
});

async function getCredentials(): Promise<
  AssumeRoleCommandOutput['Credentials']
> {
  console.log('Getting credentials');
  const response = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: ECS_ROLE,
      RoleSessionName: 'kvs-stream',
    }),
  );

  return response.Credentials;
}

async function createKvsStream(): Promise<
  CreateStreamCommandOutput['StreamARN']
> {
  console.log('Creating stream');
  const response = await kvsClient.send(
    new CreateStreamCommand({
      StreamName: `CallAnalyticsProducer-${randomUUID()}`,
      DataRetentionInHours: 1,
    }),
  );
  console.log('Stream created', JSON.stringify(response, null, 2));

  return response.StreamARN!;
}

async function deleteStream(streamArn: string): Promise<void> {
  console.log('Deleting stream');
  await kvsClient.send(
    new DeleteStreamCommand({
      StreamARN: streamArn,
    }),
  );
}

async function getEndpoint(
  streamArn: string,
): Promise<GetDataEndpointCommandOutput['DataEndpoint']> {
  console.log('Getting endpoint');
  const response = await kvsClient.send(
    new GetDataEndpointCommand({
      APIName: APIName.PUT_MEDIA,
      StreamARN: streamArn,
    }),
  );
  console.info('getDataEndpoint: ', JSON.stringify(response, null, 2));
  console.log('Got dataEndpoint');
  return response.DataEndpoint;
}

async function signRequest(
  streamArn: string,
  endpoint: string,
): Promise<{ signedUrl: aws4.Request; reqUrl: string }> {
  console.log('Signing request');
  const credentials = await getCredentials();
  if (!credentials) {
    throw new Error('Failed to get credentials');
  }
  const signedUrl = aws4.sign(
    {
      host: endpoint,
      path: '/putMedia',
      service: 'kinesisvideo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-amzn-stream-arn': streamArn,
        'x-amzn-fragment-timecode-type': 'ABSOLUTE',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
    },
    {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  );
  if (!signedUrl || !signedUrl.host || !signedUrl.path) {
    throw new Error('Failed to sign request');
  }
  console.info('Signed URL:', JSON.stringify(signedUrl, null, 2));
  console.log('Got Signed URL');

  const reqUrl = signedUrl.host + signedUrl.path;
  console.info('Request URL:', reqUrl);
  console.log('Got Request URL');
  return { signedUrl: signedUrl, reqUrl: reqUrl };
}

async function sendStream(bucketName: string, keyName: string) {
  console.log('Sending Stream');

  let filename: string = randomUUID() + '.pcm';
  await downloadInChunks({
    bucket: bucketName,
    key: keyName,
    outputPath: filename,
  });

  const { leftChannelStream, rightChannelStream } = await processFfmpeg(
    filename,
  );

  const { streamArn: leftStreamArn, startFragment: leftStreamStart } =
    await putMedia({
      stream: leftChannelStream,
    });

  const { streamArn: rightStreamArn, startFragment: rightStreamStart } =
    await putMedia({ stream: rightChannelStream });

  await startPipeline({
    leftStreamArn: leftStreamArn,
    leftStreamStart: leftStreamStart,
    rightStreamArn: rightStreamArn,
    rightStreamStart: rightStreamStart,
  });
}

async function putMedia({
  stream,
}: {
  stream: PassThrough;
}): Promise<{ streamArn: string; startFragment: string }> {
  const streamArn = await createKvsStream();
  if (!streamArn) {
    throw new Error('Failed to create stream');
  }
  const endpoint = await getEndpoint(streamArn);
  if (!endpoint) {
    throw new Error('Failed to get endpoint');
  }
  const { signedUrl, reqUrl } = await signRequest(streamArn, endpoint);
  const agent = new Agent({
    rejectUnauthorized: false,
  });

  const axiosParams = {
    method: 'POST',
    timeout: 40 * 1000,
    url: reqUrl,
    headers: signedUrl.headers as AxiosHeaders,
    data: stream,
    responseType: 'stream' as ResponseType,
    maxContentLength: Infinity,
    httpsAgent: agent,
  };

  let streamCount: number = 0;
  try {
    const response = (await axios(axiosParams)) as AxiosResponse;
    const startFragment = await getStartFragment(response);
    response.data.on('data', (chunk: Buffer) => {
      if (streamCount % COUNT_FREQUENCY === 0) {
        console.info(`Stream: ${streamArn} - Chunk: ${chunk.toString()}`);
      }
      streamCount++;
    });
    response.data.on('end', async () => {
      console.log(`Stream: ${streamArn} ended`);
      await deleteStream(streamArn);
    });

    response.data.on('error', (error: Error) => {
      console.error(`Error in ${streamArn} stream: ${error}`);
    });
    if (startFragment) {
      return { streamArn, startFragment };
    } else {
      throw new Error('StartFragment not found');
    }
  } catch (error) {
    console.error('Error in putMedia:', error);
    throw error;
  }
}

async function processFfmpeg(fileName: string): Promise<{
  leftChannelStream: PassThrough;
  rightChannelStream: PassThrough;
}> {
  console.log('Processing with ffmpeg');
  const leftChannelStream = new PassThrough();
  const rightChannelStream = new PassThrough();
  let leftCount: number = 0;
  let rightCount: number = 0;

  ffmpeg(fileName)
    .native()
    .outputOption('-af pan=mono|c0=c0')
    .output(leftChannelStream)
    .format('matroska')
    .audioCodec('pcm_s16le')
    .audioBitrate(8000)
    .on('error', (error: { message: string }) => {
      console.log('Cannot process: ' + error.message);
    })
    .on('stderr', (data: any) => {
      if (leftCount % COUNT_FREQUENCY === 0) {
        console.info(`LeftChannel: ${data}`);
      }
      leftCount++;
    })
    .run();

  ffmpeg(fileName)
    .native()
    .outputOptions('-af pan=mono|c0=c1')
    .output(rightChannelStream)
    .format('matroska')
    .audioCodec('pcm_s16le')
    .audioBitrate(8000)
    .on('error', (error: { message: string }) => {
      console.log('Cannot process: ' + error.message);
    })
    .on('stderr', (data: any) => {
      if (rightCount % COUNT_FREQUENCY === 0) {
        console.info(`RightChannel: ${data}`);
      }
      rightCount++;
    })
    .run();

  return { leftChannelStream, rightChannelStream };
}

async function startPipeline({
  leftStreamArn,
  leftStreamStart,
  rightStreamArn,
  rightStreamStart,
}: {
  leftStreamArn: string;
  leftStreamStart: string;
  rightStreamArn: string;
  rightStreamStart: string;
}) {
  console.log('Starting Media Insight Pipeline');
  const response = await chimeSdkMediaPipelineClient.send(
    new CreateMediaInsightsPipelineCommand({
      MediaInsightsPipelineConfigurationArn: MEDIA_INSIGHT_CONFIGURATION_ARN,
      KinesisVideoStreamSourceRuntimeConfiguration: {
        Streams: [
          {
            StreamArn: leftStreamArn,
            FragmentNumber: leftStreamStart,
            StreamChannelDefinition: {
              NumberOfChannels: 1,
              ChannelDefinitions: [{ ChannelId: 0, ParticipantRole: 'AGENT' }],
            },
          },
          {
            StreamArn: rightStreamArn,
            FragmentNumber: rightStreamStart,
            StreamChannelDefinition: {
              NumberOfChannels: 1,
              ChannelDefinitions: [
                { ChannelId: 1, ParticipantRole: 'CUSTOMER' },
              ],
            },
          },
        ],
        MediaEncoding: 'pcm',
        MediaSampleRate: 8000,
      },
      MediaInsightsRuntimeMetadata: {
        transactionId: randomUUID(),
      },
    }),
  );
  console.info(
    'Media Insight Pipeline Started',
    JSON.stringify(response, null, 2),
  );
  console.log('Media Insight Pipeline Started');
}

interface ChunkData {
  FragmentNumber: string;
  FragmentTimecode: string;
  EventType: string;
}

async function getStartFragment(response: AxiosResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    response.data.once('data', (chunk: Buffer) => {
      try {
        const parsedData: ChunkData = JSON.parse(chunk.toString());
        if (parsedData.FragmentNumber) {
          resolve(parsedData.FragmentNumber);
        } else {
          reject(new Error('FragmentNumber not found in the response'));
        }
      } catch (error) {
        reject(error);
      }
    });

    response.data.on('error', (error: Error) => {
      reject(error);
    });
  });
}

interface Range {
  bucket: string;
  key: string;
  start: number;
  end: number;
}

export const getObjectRange = ({ bucket, key, start, end }: Range) => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    Range: `bytes=${start}-${end}`,
  });

  return s3Client.send(command);
};

export const getRangeAndLength = (contentRange: string) => {
  const [range, length] = contentRange.split('/');
  const [start, end] = range.split('-');
  return {
    start: parseInt(start),
    end: parseInt(end),
    length: parseInt(length),
  };
};

export const isComplete = ({ end, length }: { end: number; length: number }) =>
  end === length - 1;

const downloadInChunks = async ({
  bucket,
  key,
  outputPath,
}: {
  bucket: string;
  key: string;
  outputPath: string;
}) => {
  console.log('Downloading file');
  const writeStream = createWriteStream(outputPath).on('error', (err) =>
    console.error(err),
  );

  let rangeAndLength = { start: -1, end: -1, length: -1 };

  while (!isComplete(rangeAndLength)) {
    const { end } = rangeAndLength;
    const nextRange = { start: end + 1, end: end + oneMB };

    console.info(`Downloading bytes ${nextRange.start} to ${nextRange.end}`);

    const { ContentRange, Body } = await getObjectRange({
      bucket,
      key,
      ...nextRange,
    });

    writeStream.write(await Body!.transformToByteArray());
    rangeAndLength = getRangeAndLength(ContentRange!);
  }
};

const start = async () => {
  try {
    await fastify.listen({ port: 80, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
void start();
