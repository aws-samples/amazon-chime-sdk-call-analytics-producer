# Amazon Chime SDK call analytics producer

In this demo, we will look at how to use Amazon Chime SDK call analytics without the need for a separate telephony system. Instead of using Amazon Chime SDK Voice Connector to integrate with Amazon Chime SDK call analytics, we will be streaming audio from a file to Amazon Kinesis Video Streams which will be consumed by Amazon Chime SDK call analytics. Once the audio has been sent to Amazon Chime SDK call analytics, it can be processed with the available [Amazon Chime SDK call analytics processors and sinks](https://docs.aws.amazon.com/chime-sdk/latest/dg/call-analytics-processor-and-output-destinations.html).

## Overview

![CallAnalyticsProducerOverview](/images/CallAnalyticsProducerOverview.png)

1. An object is created in the Amazon Simple Storage Service (Amazon S3) bucket. When this happens, a notification is sent to the associated AWS Lambda function.
2. This Lambda makes a request to the [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html) associated with the [AWS Fargate](https://aws.amazon.com/fargate/) task with the object information.
3. The Fargate application downloads the object from S3 and begins processing (processing details below).
4. The Fargate application streams the contents of the object to [Amazon Kinesis Video Streams](https://aws.amazon.com/kinesis/video-streams/).
5. Once started, the Kinesis Video Streams are consumed by Amazon Chime SDK call analytics.
6. Amazon Chime SDK call analytics uses [Amazon Transcribe](https://aws.amazon.com/transcribe/) to process the audio.
7. Amazon Chime SDK call analytics delivers the output of Amazon Transcribe to [Amazon Kinesis Data Streams](https://aws.amazon.com/kinesis/data-streams/)

## Audio file processing

Much of this document will assume an understanding of Node and Fargate and focus on the process of streaming an audio file to KVS for use with Amazon Chime SDK call analytics. The Fargate application will process the file in the following steps:

1. Download the object from S3
2. Process the object using [ffmpeg](https://ffmpeg.org/)
   1. Split the file into a left and right stream
   2. Convert the stream to [`matroska`](https://docs.aws.amazon.com/kinesisvideostreams/latest/dg/how-data.html) format
   3. Convert the stream to `pcm_s16le` codec
3. Send the two streams to KVS
   1. Create a new KVS Stream
   2. Get the stream endpoint
   3. Sign the request
   4. Use [PutMedia](https://docs.aws.amazon.com/kinesisvideostreams/latest/dg/API_dataplane_PutMedia.html) to send the stream to KVS
   5. Get the `FragmentNumber` of the first [Fragment](https://docs.aws.amazon.com/kinesisvideostreams/latest/dg/API_reader_Fragment.html) streamed to KVS
4. Start the Amazon Chime SDK [media insights pipeline](https://docs.aws.amazon.com/chime-sdk/latest/dg/ml-based-analytics.html) using both KVS streams

Once the Amazon Chime SDK call analytics has processed the audio, it will be delivered to an Amazon Kinesis Data Stream. In this demo, a simple KDS consumer is included so that you can see the output of the KDS in real-time.

### ffmpeg

ffmpeg is included in this demo as part of the Fargate container built with Docker.

```docker
FROM --platform=linux/arm64 node:18-alpine
RUN apk add ffmpeg

ARG FUNCTION_DIR="/function"
RUN mkdir -p ${FUNCTION_DIR}
COPY src/* ${FUNCTION_DIR}
WORKDIR ${FUNCTION_DIR}
RUN yarn
RUN yarn tsc

EXPOSE 80

CMD ["npm", "start"]
```

You will need an ARM based CPU to build and deploy this demo.

Once the object has been downloaded to the Fargate container, it will be processed with ffmpeg to split the file in to two streams and formatted for KVS.

```typescript
const leftChannelStream = new PassThrough();
let leftCount: number = 0;

ffmpeg(fileName)
  .native()
  .outputOption('-af pan=mono|c0=c0')
  .output(leftChannelStream)
  .format('matroska')
  .audioCodec('pcm_s16le')
  .audioBitrate(8000)
  .on('error', (error) => {
    console.log('Cannot process: ' + error.message);
  })
  .on('stderr', (data) => {
    if (leftCount % COUNT_FREQUENCY === 0) {
      console.info(`LeftChannel: ${data}`);
    }
    leftCount++;
  })
  .run();
```

This demo uses [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) to make processing the file easier and more readable. Here we can see the file being used as the input and read at the native frame rate. The output is a `PassThrough` stream of the left channel that uses the `matroska` format, `pcm_s16le` codec, and `8000` bitrate.

### PutMedia

Once we have the streams from `ffmpeg`, we can send them to KVS. To do this, we will use the `PutMedia` API. This requires us to [create the stream](https://docs.aws.amazon.com/kinesisvideostreams/latest/dg/API_CreateStream.html), [get the endpoint](https://docs.aws.amazon.com/kinesisvideostreams/latest/dg/API_GetDataEndpoint.html), [sign the request](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html), and use [PutMedia](https://docs.aws.amazon.com/kinesisvideostreams/latest/dg/API_dataplane_PutMedia.html) to send the stream to KVS.

```typescript
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
} catch (error) {
  console.error('Error in putMedia:', error);
  throw error;
}
```

In order to process this call with Amazon Chime SDK call analytics, we need to know the `FragmentNumber` of the first Fragment sent to KVS.

```typescript
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
```

Once we have the StreamARN and FragmentNumber, we can start the media insights pipeline.

### Amazon Chime SDK media insights pipeline

With the `leftStreamArn`, `leftStreamStart`, `rightStreamArn`, and `rightStreamStart`, we can `CreateMediaInsightsPipeline` using the previously created `MediaInsightsPipelineConfiguration`.

```typescript
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
```

Using a previously configured [`Amazon Chime SDK call analytics configuration`](https://docs.aws.amazon.com/chime-sdk/latest/dg/using-call-analytics-configurations.html) the output of the processor will be sent to the configured sink. In this demo, we are using the Amazon Transcribe processor and sending to a Kinesis Data Streams sink. This demo also includes a simple KDS consumer and UI that will display the real-time transcription being generated by Amazon Transcribe.

## Testing

Once the CDK has been deployed, you can upload a `wav` file to the created S3 bucket. This will begin the process of delivering the Transcribe results to KDS. The deployed S3 bucket will trigger an associated Lambda function when an object is created. This Lambda will make a request to the Fargate task that will start the process of downloading and streaming the audio.

![S3Upload](/images/S3Upload.png)

Included in this demo is a simple KDS consumer that will write the results to a Websocket API connected to a React application available through a CloudFront distribution.

![App](/images/AppReader.png)

## Deployment

### Requirements

- yarn installed
- ARM64 processor
- Docker desktop running

### Commands

```bash
yarn launch
```

### Cleanup

```bash
yarn cdk destroy
```
